import 'dotenv/config';
import { KiteConnect } from 'kiteconnect';

const apiKey = process.env.KITE_API_KEY;
const accessToken = process.env.KITE_ACCESS_TOKEN;

async function run() {
  console.log("🔍 Fetching NFO instruments...");
  const kite = new KiteConnect({ api_key: apiKey });
  kite.setAccessToken(accessToken);

  try {
    // Fetch NFO instruments (Segment = 'NFO')
    const instruments = await kite.getInstruments(['NFO']);
    console.log(`✅ Fetched ${instruments.length} instruments.`);

    if (instruments.length > 0) {
      console.log("\n--- SAMPLE INSTRUMENT 1 ---");
      console.log(instruments[0]);
      
      // Try to find a NIFTY option specifically
      const niftyOpt = instruments.find(i => i.name === 'NIFTY' && i.instrument_type === 'CE');
      if (niftyOpt) {
        console.log("\n--- SAMPLE NIFTY OPTION ---");
        console.log(niftyOpt);
      } else {
        console.log("\n❌ Could not find any NIFTY CE instrument to sample.");
      }
    }
  } catch (err) {
    console.error("❌ Failed:", err.message);
  }
}

run();