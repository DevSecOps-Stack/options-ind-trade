import 'dotenv/config';
import { KiteConnect } from 'kiteconnect';

const token = process.env.KITE_ACCESS_TOKEN;
const apiKey = process.env.KITE_API_KEY;

console.log("=== TOKEN DIAGNOSTIC ===");
console.log(`Token loaded from .env: "${token}"`); // Quotes reveal spaces
console.log(`Token Length: ${token ? token.length : 0}`);

if (!token || token.trim().length !== token.length) {
    console.error("❌ ERROR: Your token has hidden spaces! Open .env and delete spaces at the end.");
    process.exit(1);
} else {
    console.log("✅ Token format looks correct (no spaces).");
}

console.log("\nTesting connection to Zerodha...");
const kite = new KiteConnect({ api_key: apiKey });
kite.setAccessToken(token);

try {
    const profile = await kite.getProfile();
    console.log("✅ SUCCESS! Login worked. User:", profile.user_name);
} catch (err) {
    console.error("❌ LOGIN FAILED:", err.message);
    console.error("   Reason: The token is invalid/expired. Generate a NEW one.");
}