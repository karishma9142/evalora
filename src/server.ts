import { buildApp } from './app.js';
import { config } from './config.js';
import { recoverStaleRuns } from './runner.js';

recoverStaleRuns(); // runs interrupted by a restart can never finish

const app = buildApp();

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
