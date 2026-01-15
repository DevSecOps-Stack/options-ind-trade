import fs from 'fs';
import path from 'path';
import { KiteConnect } from 'kiteconnect';
import { logger } from '../utils/logger.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

interface SessionData {
  accessToken: string;
  loginTime: string;
}

export class SessionManager {
  private apiSecret: string;

  constructor(apiSecret: string) {
    this.apiSecret = apiSecret;
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR);
    }
  }

  /**
   * Tries to load a valid existing session.
   * Returns token if valid (from today), null otherwise.
   */
  async getValidSession(): Promise<string | null> {
    if (!fs.existsSync(SESSION_FILE)) return null;

    try {
      const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
      const data: SessionData = JSON.parse(raw);
      
      // Check if session is from today
      const loginDate = new Date(data.loginTime);
      const today = new Date();
      
      const isSameDay = loginDate.getDate() === today.getDate() &&
                        loginDate.getMonth() === today.getMonth() &&
                        loginDate.getFullYear() === today.getFullYear();

      if (!isSameDay) {
        logger.info('Previous session is expired (new day).');
        return null;
      }

      return data.accessToken;
    } catch (error) {
      return null;
    }
  }

  /**
   * Generates a new session from a Request Token and saves it.
   */
  async generateSession(apiKey: string, requestToken: string): Promise<string> {
    try {
      const kite = new KiteConnect({ api_key: apiKey });
      const response = await kite.generateSession(requestToken, this.apiSecret);
      const accessToken = response.access_token;

      const sessionData: SessionData = {
        accessToken,
        loginTime: new Date().toISOString()
      };

      fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
      logger.info('New session saved to disk.');
      
      return accessToken;
    } catch (error) {
      logger.error('Failed to generate session', error);
      throw error;
    }
  }
}