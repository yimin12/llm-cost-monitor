.PHONY: refresh-pricing help

help:
	@echo "llm-cost-monitor — Electron tray app (macOS + Linux)"
	@echo ""
	@echo "Development:"
	@echo "  npm install          # install all dependencies (run once after clone)"
	@echo "  npm run dev          # start in dev mode — tray icon + dropdown"
	@echo "  npm run typecheck    # TypeScript strict check (zero errors expected)"
	@echo "  npm run lint         # ESLint check"
	@echo "  npm run test         # Vitest unit tests"
	@echo ""
	@echo "Distribution:"
	@echo "  npm run dist:mac     # build + package .dmg (macOS universal)"
	@echo "  npm run dist:linux   # build + package .deb + .AppImage"
	@echo "  npm run dist         # build + package all platforms"
	@echo ""
	@echo "Maintenance:"
	@echo "  make refresh-pricing # snapshot LiteLLM pricing into resources/pricing.json"

refresh-pricing:
	bash Scripts/refresh-pricing.sh
