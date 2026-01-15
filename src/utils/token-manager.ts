import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';

const TOKEN_PATH = path.join(process.cwd(), 'data', 'token.json');

// Use any type for kite due to kiteconnect package type definition issues
export class TokenManager {
  constructor(private kite: any, private apiKey: string, private apiSecret: string) {}

  async loadToken(): Promise<boolean> {
    try {
      const data = await fs.readFile(TOKEN_PATH, 'utf-8');
      const { access_token, login_time } = JSON.parse(data);

      const loginDate = new Date(login_time);
      const now = new Date();
      // Reset if date changed (Zerodha tokens expire daily)
      if (loginDate.getDate() !== now.getDate()) return false;

      this.kite.setAccessToken(access_token);
      return true;
    } catch (error) {
      return false;
    }
  }

  async handleLogin(requestToken: string): Promise<string> {
    const response = await this.kite.generateSession(requestToken, this.apiSecret);
    const payload = { access_token: response.access_token, login_time: new Date().toISOString() };
    
    await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
    await fs.writeFile(TOKEN_PATH, JSON.stringify(payload, null, 2));
    
    this.kite.setAccessToken(response.access_token);
    return response.user_name || 'User';
  }
}