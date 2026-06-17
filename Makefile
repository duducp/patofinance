.PHONY: help install install-login install-link dev dev-stop dev-serve dev-logs dev-deploy dev-db-push dev-db-reset dev-test-start dev-test-gasto dev-test-saldo dev-test-receita dev-test-detalhes dev-test-callback check lint test test-boot unit prod-deploy prod-deploy-fn prod-db-push prod-webhook-set prod-webhook-info prod-webhook-delete prod-logs secrets status open landing-open

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

dev-serve: ## [LOCAL] Run Edge Function locally (streams logs)
	supabase functions serve bot-core

dev-logs: dev-serve ## [LOCAL] Alias for dev-serve

dev-deploy: ## [LOCAL] Deploy Edge Function locally
	supabase functions deploy bot-core --no-verify-jwt

dev-db-push: ## [LOCAL] Push database migrations locally
	supabase db push --local

dev-db-reset: ## [LOCAL] Reset local database
	supabase db reset

# Common curl args for local testing
CURL_ARGS = -X POST http://127.0.0.1:54321/functions/v1/bot-core \
	-H "Content-Type: application/json" \
	-H "apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH" \
	-H "X-Telegram-Bot-Api-Secret-Token: test_secret"

dev-test-start: ## [LOCAL] Test /start
	curl $(CURL_ARGS) \
		-d '{"update_id": 1, "message": {"message_id": 1, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/start"}}'

dev-test-gasto: ## [LOCAL] Test /gasto (aka /despesa)
	curl $(CURL_ARGS) \
		-d '{"update_id": 2, "message": {"message_id": 2, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/gasto 50 alimentação"}}'

dev-test-saldo: ## [LOCAL] Test /saldo
	curl $(CURL_ARGS) \
		-d '{"update_id": 3, "message": {"message_id": 3, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/saldo"}}'

dev-test-receita: ## [LOCAL] Test /receita
	curl $(CURL_ARGS) \
		-d '{"update_id": 4, "message": {"message_id": 4, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/receita 3000 salário"}}'

dev-test-detalhes: ## [LOCAL] Test /detalhes <id>
	curl $(CURL_ARGS) \
		-d '{"update_id": 5, "message": {"message_id": 5, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/detalhes 1"}}'

dev-test-callback: ## [LOCAL] Test a callback (ex: txlist_p1)
	curl $(CURL_ARGS) \
		-d '{"update_id": 100, "callback_query": {"id": "cb1", "from": {"id": 123}, "message": {"message_id": 1, "chat": {"id": 123, "type": "private"}, "date": 1234567890}, "data": "txlist_p1"}}'

# ============================================
# PRODUÇÃO
# ============================================

prod-deploy: prod-db-push ## [PROD] Push migrations + deploy Edge Function
	supabase functions deploy bot-core --no-verify-jwt

prod-deploy-fn: ## [PROD] Deploy Edge Function only
	supabase functions deploy bot-core --no-verify-jwt

prod-db-push: ## [PROD] Push database migrations to production
	supabase db push --yes

prod-webhook-set: ## [PROD] Set Telegram webhook
	@if [ -z "$(BOT_TOKEN)" ]; then \
		read -p "Bot Token (from @BotFather): " bot_token; \
	else \
		bot_token="$(BOT_TOKEN)"; \
	fi; \
	read -p "Project URL (ex: https://xyz.supabase.co): " project_url; \
	read -p "Secret Token: " secret_token; \
	curl -X POST "https://api.telegram.org/bot$$bot_token/setWebhook" \
		-H "Content-Type: application/json" \
		-d "{\"url\": \"$$project_url/functions/v1/bot-core\", \"secret_token\": \"$$secret_token\"}"

prod-webhook-info: ## [PROD] Check Telegram webhook status
	@if [ -z "$(BOT_TOKEN)" ]; then \
		read -p "Bot Token (from @BotFather): " bot_token; \
		curl "https://api.telegram.org/bot$$bot_token/getWebhookInfo" | jq .; \
	else \
		curl "https://api.telegram.org/bot$(BOT_TOKEN)/getWebhookInfo" | jq .; \
	fi

prod-webhook-delete: ## [PROD] Delete Telegram webhook
	@if [ -z "$(BOT_TOKEN)" ]; then \
		read -p "Bot Token (from @BotFather): " bot_token; \
		curl -X POST "https://api.telegram.org/bot$$bot_token/deleteWebhook" | jq .; \
	else \
		curl -X POST "https://api.telegram.org/bot$(BOT_TOKEN)/deleteWebhook" | jq .; \
	fi

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

# ============================================
# LANDING PAGE
# ============================================

landing-open: ## [LANDING] Open landing page locally
	@echo "🌐 Opening landing page at http://127.0.0.1:8080"
	@open "http://127.0.0.1:8080"
	@echo "   (Press Ctrl+C to stop)"
	@python3 -m http.server 8080 -d landing/ &

# ============================================
# QUALITY
# ============================================

check: ## [QA] Type-check using Deno
	deno check supabase/functions/bot-core/index.ts

lint: ## [QA] Lint edge function code
	deno lint supabase/functions/bot-core/

unit: ## [QA] Run unit tests
	deno test --allow-env supabase/functions/bot-core/

test-boot: ## [QA] Verify function boots without error
	@echo "Checking function boot..."
	@if supabase status >/dev/null 2>&1; then \
		supabase functions serve bot-core --no-verify-jwt > /tmp/supabase-boot.log 2>&1 & \
		PID=$$!; \
		sleep 5; \
		kill $$PID 2>/dev/null; \
		if grep -q "boot error" /tmp/supabase-boot.log 2>/dev/null; then \
			echo "❌ FAIL"; \
		else \
			echo "✅ OK"; \
		fi; \
		rm -f /tmp/supabase-boot.log; \
	else \
		echo "⚠️  SKIP (local Supabase not running; run 'make dev' first)"; \
	fi

test: check lint unit test-boot ## [QA] Run all checks
