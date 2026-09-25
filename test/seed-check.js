
const { Vault, MemoryAdapter } = require('../src/core/vault.js');
const seed = require('../src/data/seed.json');
(async () => {
  const v = new Vault({ adapter: new MemoryAdapter() });
  await v.init();
  const r = await v.importJSON(seed.codes);
  console.log('imported codes:', JSON.stringify(r));
  const st = await v.stats();
  console.log('stats:', JSON.stringify(st));
  console.log('shareable:', (await v.shareableList()).length);
  console.log('untried:', (await v.byStatus('untried')).map(x=>x.code).join(','));
  const csv = await v.exportCSV();
  console.log('csv lines:', csv.split('\n').length, '| has token?', /token|cookie|session/i.test(csv));
})().catch(e => { console.error('ERR', e.message); process.exitCode=1; });
