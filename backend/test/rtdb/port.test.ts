/** The rtdb suite on the local JSON tree (in memory). */
process.env.TM_RTDB_FILE = ':memory:';
const { localRtdb } = await import('../../src/rtdb/local.js');
const { rtdbSuite } = await import('./suite.js');
rtdbSuite(
  'local',
  () => localRtdb.db(),
  () => localRtdb.TIMESTAMP,
);
