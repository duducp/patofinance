.PHONY: help install install-login install-link dev dev-stop dev-logs dev-deploy dev-db-push dev-db-reset dev-test-start dev-test-gasto prod-deploy prod-db-push prod-webhook-set prod-webhook-info prod-webhook-delete prod-logs secrets status open

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-25s\033[0m %s\n", $$1, $$2}'

# ============================================
# INSTALAÇÃO
# ============================================

install: ## Install Supabase CLI
	@if command -v supabase >/dev/null 2>&1; then \
		echo "Supabase CLI already installed"; \
		supabase --version; \
	else \
		echo "Installing Supabase CLI..."; \
		brew install supabase/tap/supabase; \
	fi

install-login: ## Login to Supabase (run after install)
	@read -p "Supabase Access Token: " token; \
	supabase login --token $$token

install-link: ## Link to Supabase project (run after login)
	supabase link --project-ref zjcfjqtlijktrikgvwrv

# ============================================
# LOCAL
# ============================================

dev: ## [LOCAL] Start local Supabase
	supabase start

dev-stop: ## [LOCAL] Stop local Supabase
	supabase stop

dev-logs: ## [LOCAL] Show local Edge Function logs
	supabase functions serve bot-core

dev-deploy: ## [LOCAL] Deploy Edge Function locally
	supabase functions deploy bot-core --no-verify-jwt --local

dev-db-push: ## [LOCAL] Push database migrations locally
	supabase db push --local

dev-db-reset: ## [LOCAL] Reset local database
	supabase db reset

dev-test-start: ## [LOCAL] Test /start command locally
	curl -X POST http://127.0.0.1:54321/functions/v1/bot-core \
		-H "Content-Type: application/json" \
		-H "apikey: $(SUPABASE_ANON_KEY)" \
		-H "X-Telegram-Bot-Api-Secret-Token: $(TELEGRAM_SECRET_TOKEN)" \
		-d '{"update_id": 1, "message": {"message_id": 1, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/start"}}' | jq .

dev-test-gasto: ## [LOCAL] Test /gasto command locally
	curl -X POST http://127.0.0.1:54321/functions/v1/bot-core \
		-H "Content-Type: application/json" \
		-H "apikey: $(SUPABASE_ANON_KEY)" \
		-H "X-Telegram-Bot-Api-Secret-Token: $(TELEGRAM_SECRET_TOKEN)" \
		-d '{"update_id": 2, "message": {"message_id": 2, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/gasto 50 alimentação"}}' | jq .

# ============================================
# PRODUÇÃO
# ============================================

prod-deploy: ## [PROD] Deploy Edge Function to production
	supabase functions deploy bot-core --no-verify-jwt

prod-db-push: ## [PROD] Push database migrations to production
	supabase db push

prod-webhook-set: ## [PROD] Set Telegram webhook
	@read -p "Project URL (ex: https://xyz.supabase.co): " project_url; \
	read -p "Secret Token: " secret_token; \
	curl -X POST "https://api.telegram.org/bot$(BOT_TOKEN)/setWebhook" \
		-H "Content-Type: application/json" \
		-d "{\"url\": \"$$project_url/functions/v1/bot-core\", \"secret_token\": \"$$secret_token\"}"

prod-webhook-info: ## [PROD] Check Telegram webhook status
	curl "https://api.telegram.org/bot$(BOT_TOKEN)/getWebhookInfo" | jq .

prod-webhook-delete: ## [PROD] Delete Telegram webhook
	curl -X POST "https://api.telegram.org/bot$(BOT_TOKEN)/deleteWebhook" | jq .

prod-logs: ## [PROD] Show recent deployment logs
	supabase functions logs bot-core

# ============================================
# AMBOS
# ============================================

secrets: ## Set secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_SECRET_TOKEN)
	@read -p "Bot Token: " bot_token; \
	read -p "Secret Token: " secret_token; \
	supabase secrets set TELEGRAM_BOT_TOKEN=$$bot_token TELEGRAM_SECRET_TOKEN=$$secret_token

status: ## Show Supabase project status
	supabase status

open: ## Open Supabase Dashboard
	open "https://supabase.com/dashboard/project/zjcfjqtlijktrikgvwrv"
