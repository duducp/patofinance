-- Add wizard step options for recorrencia type step (expense/income)
INSERT INTO wizard_step_options (step_id, value, label, sort_order)
SELECT ws.id, v.value, v.label, v.sort_order
FROM wizard_steps ws
CROSS JOIN (VALUES
  ('expense', '💸 Despesa', 1),
  ('income', '💰 Receita', 2)
) AS v(value, label, sort_order)
WHERE ws.wizard_name = 'recorrencia' AND ws.step_key = 'type'
AND NOT EXISTS (
  SELECT 1 FROM wizard_step_options wso
  WHERE wso.step_id = ws.id AND wso.value = v.value
);
