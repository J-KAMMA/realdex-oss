/** Ephemeral keys + synthetic ledgers for browser integration. No user data. */
import {accountOnlineFixture} from '../../wallet/test/account-online-fixtures.mjs';
import {PASSWORD} from '../../wallet/test/fixtures.mjs';
const stellar=await accountOnlineFixture('stellar'),aptos=await accountOnlineFixture('aptos');
try{
  const a=await stellar.vault.addAccount({family:'aptos',label:'PUBLIC APT TEST KEY',secretHex:'31'.repeat(32)});
  const backup=await stellar.vault.backup();await stellar.vault.verifyBackup(backup.encrypted,PASSWORD);
  stellar.app.settings.accountNetworks.push(aptos.network);
  console.log(JSON.stringify({url:stellar.started.origin+'/wallet/#key='+stellar.app.uiToken,stellarTo:stellar.to,aptosTo:aptos.to,stellarAccount:stellar.account.id,aptosAccount:a.id}));
  const stop=async()=>{await stellar.close();await aptos.close();process.exit(0);};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}catch(e){await stellar.close();await aptos.close();throw e;}
