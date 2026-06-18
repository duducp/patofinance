-- 20260618000001_add_recurrences.sql

-- Recurrences table
CREATE TABLE recurrences (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  amount DECIMAL(12,2) NOT NULL,
  description TEXT DEFAULT '',
  category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  group_id BIGINT REFERENCES groups(id) ON DELETE SET NULL,
  tags TEXT[] DEFAULT '{}',
  frequency_type TEXT NOT NULL CHECK (frequency_type IN ('daily', 'weekly', 'monthly', 'annual', 'every_x_days')),
  frequency_interval INT,
  frequency_month INT,
  next_date DATE NOT NULL,
  last_processed_date DATE,
  is_archived BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_recurrences_user ON recurrences(user_id);
CREATE INDEX idx_recurrences_processing ON recurrences(next_date) WHERE is_archived = FALSE;

-- RLS
ALTER TABLE recurrences ENABLE ROW LEVEL SECURITY;

CREATE POLICY recurrences_select_own ON recurrences
  FOR SELECT USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY recurrences_insert_own ON recurrences
  FOR INSERT WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY recurrences_update_own ON recurrences
  FOR UPDATE USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY recurrences_delete_own ON recurrences
  FOR DELETE USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

GRANT ALL ON recurrences TO service_role, authenticated;
GRANT USAGE ON SEQUENCE recurrences_id_seq TO service_role, authenticated;

-- Alter transactions
ALTER TABLE transactions ADD COLUMN recurrence_id BIGINT REFERENCES recurrences(id) ON DELETE SET NULL;
CREATE INDEX idx_transactions_recurrence ON transactions(recurrence_id);

-- Notification queue
CREATE TABLE notification_queue (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  delivered BOOLEAN DEFAULT FALSE
);

GRANT ALL ON notification_queue TO service_role, authenticated;
GRANT USAGE ON SEQUENCE notification_queue_id_seq TO service_role, authenticated;

-- Helper: calculate next recurrence date
CREATE OR REPLACE FUNCTION calculate_next_date(
  p_current_date DATE,
  p_frequency_type TEXT,
  p_interval INT,
  p_month INT
) RETURNS DATE AS $$
DECLARE
  next_d DATE;
  target_day INT;
  last_day_of_month INT;
BEGIN
  next_d := p_current_date;

  CASE p_frequency_type
    WHEN 'daily' THEN
      next_d := next_d + 1;
    WHEN 'every_x_days' THEN
      next_d := next_d + p_interval;
    WHEN 'weekly' THEN
      next_d := next_d + ((p_interval - EXTRACT(DOW FROM next_d)::INT + 7) % 7)::INT;
      IF next_d = p_current_date THEN
        next_d := next_d + 7;
      END IF;
    WHEN 'monthly' THEN
      target_day := p_interval;
      next_d := next_d + INTERVAL '1 month';
      last_day_of_month := EXTRACT(DAY FROM (DATE_TRUNC('MONTH', next_d) + INTERVAL '1 month - 1 day')::DATE);
      IF target_day > last_day_of_month THEN
        target_day := last_day_of_month;
      END IF;
      next_d := DATE_TRUNC('MONTH', next_d)::DATE + (target_day - 1);
    WHEN 'annual' THEN
      target_day := p_interval;
      next_d := next_d + INTERVAL '1 year';
      last_day_of_month := EXTRACT(DAY FROM (DATE_TRUNC('MONTH', next_d) + INTERVAL '1 month - 1 day')::DATE);
      IF target_day > last_day_of_month THEN
        target_day := last_day_of_month;
      END IF;
      next_d := DATE_TRUNC('MONTH', next_d)::DATE + (target_day - 1);
      IF p_month IS NOT NULL THEN
        next_d := DATE_TRUNC('YEAR', next_d)::DATE + (p_month - 1) * INTERVAL '1 month';
        last_day_of_month := EXTRACT(DAY FROM (DATE_TRUNC('MONTH', next_d) + INTERVAL '1 month - 1 day')::DATE);
        IF target_day > last_day_of_month THEN
          target_day := last_day_of_month;
        END IF;
        next_d := DATE_TRUNC('MONTH', next_d)::DATE + (target_day - 1);
      END IF;
  END CASE;

  RETURN next_d;
END;
$$ LANGUAGE plpgsql;

-- Process recurrences: create transactions and advance dates
CREATE OR REPLACE FUNCTION process_recurrences()
RETURNS TABLE(recurrence_id BIGINT, p_user_id BIGINT, status TEXT, detail TEXT) AS $$
DECLARE
  rec RECORD;
  next_d DATE;
  v_user_id BIGINT;
  v_category_exists BOOLEAN;
  v_group_exists BOOLEAN;
  v_error_msg TEXT;
BEGIN
  FOR rec IN
    SELECT r.* FROM recurrences r
    WHERE r.next_date <= CURRENT_DATE
      AND r.is_archived = FALSE
      AND (r.last_processed_date IS NULL OR r.last_processed_date < r.next_date)
    ORDER BY r.next_date ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    v_error_msg := NULL;
    v_category_exists := TRUE;
    v_group_exists := TRUE;

    IF rec.category_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM categories WHERE id = rec.category_id) THEN
        v_category_exists := FALSE;
        v_error_msg := COALESCE(v_error_msg || '; ', '') || 'categoria não encontrada';
      END IF;
    END IF;

    IF rec.group_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM groups WHERE id = rec.group_id) THEN
        v_group_exists := FALSE;
        v_error_msg := COALESCE(v_error_msg || '; ', '') || 'grupo não encontrado';
      END IF;
    END IF;

    INSERT INTO transactions (user_id, type, amount, description, category_id, group_id, tags, recurrence_id, transaction_date)
    VALUES (
      rec.user_id, rec.type, rec.amount,
      COALESCE(rec.description, ''),
      CASE WHEN v_category_exists THEN rec.category_id ELSE NULL END,
      CASE WHEN v_group_exists THEN rec.group_id ELSE NULL END,
      rec.tags, rec.id, rec.next_date
    );

    next_d := calculate_next_date(rec.next_date, rec.frequency_type, rec.frequency_interval, rec.frequency_month);

    UPDATE recurrences SET
      next_date = next_d,
      last_processed_date = rec.next_date,
      updated_at = NOW()
    WHERE id = rec.id;

    IF v_error_msg IS NOT NULL THEN
      INSERT INTO notification_queue (user_id, message)
      VALUES (rec.user_id,
        '⚠️ *Recorrência processada com aviso:*\n\n' ||
        '💰 Valor: R$ ' || rec.amount::TEXT || '\n' ||
        '📅 Data: ' || rec.next_date::TEXT || '\n\n' ||
        'Problema: ' || v_error_msg || '. Verifique os dados.'
      );
    END IF;

    recurrence_id := rec.id;
    p_user_id := rec.user_id;
    status := CASE WHEN v_error_msg IS NULL THEN 'ok' ELSE 'warning' END;
    detail := v_error_msg;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$ LANGUAGE plpgsql;

-- Schedule daily cron at 09:00 UTC (06:00 BRT)
SELECT cron.schedule('process-recurrences', '0 9 * * *', $$SELECT process_recurrences()$$);

-- Wizard steps for recorrencia
INSERT INTO wizard_steps (wizard_name, step_order, step_key, prompt, input_type, is_required)
VALUES
  ('recorrencia', 1, 'type', '💸 *Despesa* ou 💰 *Receita*?', 'select', TRUE),
  ('recorrencia', 2, 'amount', '💰 Qual o valor?', 'text', TRUE),
  ('recorrencia', 3, 'description', '📝 Qual a descrição? (ou /pular)', 'text', FALSE),
  ('recorrencia', 4, 'category', '🏷️ Qual a categoria?', 'select', TRUE),
  ('recorrencia', 5, 'group', '📁 Qual o grupo?', 'select', TRUE),
  ('recorrencia', 6, 'frequency', '🔄 Qual a frequência?', 'select', TRUE),
  ('recorrencia', 7, 'tags', '🔖 Tags? (opcional)', 'tags', FALSE),
  ('recorrencia', 8, 'start_date', '📅 Qual a data da primeira ocorrência?', 'date', TRUE);

-- Wizard step options for frequency
INSERT INTO wizard_step_options (step_id, value, label, sort_order)
SELECT ws.id, v.value, v.label, v.sort_order
FROM wizard_steps ws
CROSS JOIN (VALUES
  ('daily', '📅 Diária', 1),
  ('weekly', '📅 Semanal', 2),
  ('monthly', '📅 Mensal', 3),
  ('annual', '📅 Anual', 4),
  ('every_x_days', '📅 A cada X dias', 5)
) AS v(value, label, sort_order)
WHERE ws.wizard_name = 'recorrencia' AND ws.step_key = 'frequency';
