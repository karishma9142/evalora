import { buildApp } from './app.js';
import { config } from './config.js';
import { describeStorage } from './diagnostics.js';
import { recoverStaleRuns } from './runner.js';

describeStorage(); // which database is in use, what is in it, and whether stored keys can be decrypted
recoverStaleRuns(); // runs interrupted by a restart can never finish

const app = buildApp();

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
