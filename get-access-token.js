// Run this: node get-access-token.js <YOUR_REQUEST_TOKEN_FROM_URL>
import 'dotenv/config';
import { KiteConnect } from 'kiteconnect';

const apiKey = process.env.KITE_API_KEY;
const apiSecret = process.env.KITE_API_SECRET;
const requestToken = process.argv[2];

if (!requestToken) {
    console.error("❌ ERROR: Please provide the request_token as an argument.");
    console.log("Usage: node get-access-token.js <request_token>");
    process.exit(1);
}

console.log("🔄 Exchanging Request Token for Access Token...");

const kite = new KiteConnect({ api_key: apiKey });

try {
    // This performs the login exchange
    const response = await kite.generateSession(requestToken, apiSecret);
    
    console.log("\n✅ SUCCESS! Here is your real ACCESS TOKEN:");
    console.log("---------------------------------------------------");
    console.log(response.access_token);
    console.log("---------------------------------------------------");
    console.log("👉 Copy the value above and paste it into your .env file as KITE_ACCESS_TOKEN");
} catch (err) {
    console.error("\n❌ FAILED:", err.message);
    if (err.message.includes("Token is invalid")) {
        console.error("   Reason: The request_token has expired or was already used.");
        console.error("   Solution: Login again in the browser to get a fresh request_token.");
    }
}