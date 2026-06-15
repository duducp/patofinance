.PHONY: help dev deploy deploy-local logs secrets webhook test

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

dev: ## Start local Supabase
	supabase start

dev-stop: ## Stop local Supabase
	supabase stop

dev-logs: ## Show local Edge Function logs
	supabase functions serve bot-core

deploy: ## Deploy Edge Function to production
	supabase functions deploy bot-core --no-verify-jwt

deploy-local: ## Deploy to local environment
	supabase functions deploy bot-core --no-verify-jwt --local

db-push: ## Push database migrations
	supabase db push

db-reset: ## Reset local database
	supabase db reset

secrets: ## Set secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_SECRET_TOKEN)
	@read -p "Bot Token: " bot_token; \
	read -p "Secret Token: " secret_token; \
	supabase secrets set TELEGRAM_BOT_TOKEN=$$bot_token TELEGRAM_SECRET_TOKEN=$$secret_token

webhook-set: ## Set Telegram webhook
	@read -p "Project URL (ex: https://xyz.supabase.co): " project_url; \
	read -p "Secret Token: " secret_token; \
	curl -X POST "https://api.telegram.org/bot$(BOT_TOKEN)/setWebhook" \
		-H "Content-Type: application/json" \
		-d "{\"url\": \"$$project_url/functions/v1/bot-core\", \"secret_token\": \"$$secret_token\"}"

webhook-info: ## Check Telegram webhook status
	curl "https://api.telegram.org/bot$(BOT_TOKEN)/getWebhookInfo" | jq .

webhook-delete: ## Delete Telegram webhook
	curl -X POST "https://api.telegram.org/bot$(BOT_TOKEN)/deleteWebhook" | jq .

test-start: ## Test /start command locally
	curl -X POST http://127.0.0.1:54321/functions/v1/bot-core \
		-H "Content-Type: application/json" \
		-H "apikey: $(SUPABASE_ANON_KEY)" \
		-H "X-Telegram-Bot-Api-Secret-Token: $(TELEGRAM_SECRET_TOKEN)" \
		-d '{"update_id": 1, "message": {"message_id": 1, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/start"}}' | jq .

test-gasto: ## Test /gasto command locally
	curl -X POST http://127.0.0.1:54321/functions/v1/bot-core \
		-H "Content-Type: application/json" \
		-H "apikey: $(SUPABASE_ANON_KEY)" \
		-H "X-Telegram-Bot-Api-Secret-Token: $(TELEGRAM_SECRET_TOKEN)" \
		-d '{"update_id": 2, "message": {"message_id": 2, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/gasto 50 alimentação"}}' | jq .

logs: ## Show recent deployment logs
	supabase functions logs bot-core

status: ## Show Supabase project status
	supabase status

open: ## Open Supabase Dashboard
	open "https://supabase.com/dashboard/project/$$(supabase status | grep 'Project URL' | awk '{print $$NF}' | sed 's|https://||' | sed 's|\.supabase\.co||')"
