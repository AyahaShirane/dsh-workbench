import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

test('native panel owns complete English and Chinese locale catalogs', async () => {
  const source = await readFile(new URL('../src/client.jsx', import.meta.url), 'utf8')
  assert.match(source, /ctx\.locale\.register\(['"]workbench['"],\s*\{\s*zh\s*,\s*en\s*\}\)/)
  assert.match(source, /locale:\s*['"]workbench['"]\s*,/)
  assert.match(source, /data-testid=['"]operator-token['"]/)
  assert.match(source, /data-testid=['"]task-detail['"]/)
  const catalogs = source.match(/const (?:zh|en)=\{[\s\S]*?\n\}/g) || []
  assert.equal(catalogs.length, 2, 'both locale catalogs are defined')
  assert.doesNotMatch(source, />[^<{]*[\u3400-\u9fff][^<{]*</, 'production-owned panel labels are translated')
})
