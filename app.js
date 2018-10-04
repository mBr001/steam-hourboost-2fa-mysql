// Requirements
const crypto = require('crypto');
const log = require('npmlog');
const mysql = require('mysql');
const Steam = require('steam');
const SteamTotp = require ('steam-totp');

// Loading Config File
const config = require('./config.json');

//Login delay to prevent steam bans
const LOGIN_DELAY = 50;

// This will be needed to encrypt the sentry
const SHA1 = bytes => {
  const sum = crypto.createHash('sha1');
  sum.end(bytes);
  return sum.read();
};

// Splitting the games
const getGames = games => {
  const str = games.split(',');
  const final = [];
  for (const game of str) final.push({ game_id: parseInt(game) });
  return final;
};

// Establishing the MySQL Connection
const db = mysql.createConnection(config.mysql);
if (config.mysql.user === 'root') log.warn('mysql', 'Using the root user in production is highly discouraged');

// MySQL Connection Log
db.connect(err => {
  if (err) {
    log.error('mysql', "Can't connect to server:\n%s", err.stack);
    return process.exit();
  }
  log.info('mysql', 'Connection successful (%s:%d)', config.mysql.host, config.mysql.port);
});

// Fetching all accounts from the database
db.query('SELECT * FROM hourboost', (err, rows, fields) => {
  if (err) return log.error('mysql', 'Query failed:\n%s', err.stack);

  // Creating const and store all table rows in it
  const accounts = [];
  for (const row of rows) accounts.push([row.username, row.password, row.games, row.secret, row.sentry]);

  // Logging how many accounts have been found
  log.info('mysql', 'Found %d account' + (accounts.length != 1 ? 's' : ''), accounts.length);

  accounts.forEach((account, i) => {
    const steamClient = new Steam.SteamClient();
    const steamUser = new Steam.SteamUser(steamClient);
    const steamFriends = new Steam.SteamFriends(steamClient);

    setTimeout(() => {
      log.info('steam', '%s: Logging in...', account[0]);
      steamClient.connect();

      var authCode = SteamTotp.generateAuthCode(`${account[3]}`);
      const sentryFile = account[4] === null ? null : SHA1(new Buffer(account[4], 'base64'));

      // Checking if Shared Secret is given. If so, we will login with it
      if (account[3] !== null) {
        steamClient.on('connected', () => {
          steamUser.logOn({
            account_name: account[0],
            password: account[1],
            two_factor_code: authCode
          });
        });

        // Checking if Sentry is given. If so, we will login with it, if Shared Secret is not given.
      } else if (account[4] !== null) {
        steamClient.on('connected', () => {
          steamUser.logOn({
            account_name: account[0],
            password: account[1],
            sha_sentryfile: sentryFile
          });
        });

        // If no Shared Secret and no Sentry is given, we will login normally (requires Steam Guard/Mobile Auth disabled!)
      } else {
        steamClient.on('connected', () => {
          steamUser.logOn({
            account_name: account[0],
            password: account[1]
          });
        });
      }

      steamClient.on('logOnResponse', logonResp => {
        if (logonResp.eresult == Steam.EResult.OK) {
          log.info('steam', '%s: Successfully logged in', account[0]);

          steamFriends.setPersonaState(Steam.EPersonaState.Online);
          steamUser.gamesPlayed(getGames(account[2]));

          log.info('steam', '%s: Games (%s) and online status have been set', account[0], account[2]);
        }
      });

      steamClient.on('error', err => {
        log.error('steam', '%s: Login failed', account[0]);
        if (Steam.EResult.InvalidPassword) {
          log.error('steam', 'Reason: invalid password');
        } else if (Steam.EResult.AlreadyLoggedInElsewhere) {
          log.error('steam', 'Reason: already logged in elsewhere');
        } else if (Steam.EResult.AccountLogonDenied) {
          log.error('steam', 'Reason: logon denied - SteamGuard needed');
        }
        log.info('steam', '%s: Retrying login in 5 minutes', account[0]);
        setTimeout(() => {
          log.info('steam', '%s: Retrying login', account[0]);
          steamClient.connect();
        }, 5 * 60000);
      });
    }, LOGIN_DELAY * i);
  });
});
