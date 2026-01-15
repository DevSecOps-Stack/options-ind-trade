import 'dotenv/config';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { runCLI } from './cli/index.js'; // Imports from the CLI folder
import { SessionManager } from './core/session-manager.js';

const apiKey = process.env.KITE_API_KEY!;
const apiSecret = process.env.KITE_API_SECRET!;

async function main() {
  console.clear();
  console.log(chalk.bgBlue.white.bold('\n 🚀 NSE TRADING TERMINAL \n'));

  // 1. Session Check
  const sessionMgr = new SessionManager(apiSecret);
  let accessToken = await sessionMgr.getValidSession();

  if (accessToken) {
    console.log(chalk.green('✓ Valid Session Found (Auto-Login)'));
  } else {
    console.log(chalk.yellow('! Session Expired or Missing.'));
    console.log(chalk.gray(`1. Login here: https://kite.trade/connect/login?api_key=${apiKey}`));
    console.log(chalk.gray('2. Copy the "request_token" from the URL.'));
    
    const { reqToken } = await inquirer.prompt([{
      type: 'input',
      name: 'reqToken',
      message: 'Enter Request Token:',
      validate: (input) => input.length > 5 || 'Invalid Token'
    }]);

    try {
      accessToken = await sessionMgr.generateSession(apiKey, reqToken);
      console.log(chalk.green('✓ Login Successful! Session Saved.'));
    } catch (err) {
      console.error(chalk.red('❌ Login Failed. Check Request Token.'));
      process.exit(1);
    }
  }

  // Update Process Env so the CLI can use it
  process.env.KITE_ACCESS_TOKEN = accessToken;

  // 2. Launch Dashboard directly
  console.log(chalk.cyan('\nLaunching Dashboard...'));
  
  // Explicitly run the 'start' command
  await runCLI(['start']); 
}

main().catch(console.error);