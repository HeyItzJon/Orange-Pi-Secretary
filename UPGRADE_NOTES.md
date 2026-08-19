# yahoo-finance2 Upgrade Note

**Current:** v2.14.2 (deprecated, but functional)
**Next:** v3.x (newer, maintained)

## When to upgrade to v3
- After this version is stable and working
- When you want security patches and active maintenance
- The API changes are minor (mostly just the import)

## How to upgrade later
When npm access is available:
```bash
npm install yahoo-finance2@3
```

Then update `marketData.js` line 16:
```javascript
// From:
import yahooFinance from "yahoo-finance2";

// To:
import { default as yahooFinance } from "yahoo-finance2";
// OR check the v3 docs for the new export pattern
```

The rest of the code should work unchanged. For now, v2.14.2 is fine — it's been tested and the deprecation warning is just advisory.
