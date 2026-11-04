// Tests for the stack manager's pure helpers. Run: node --test dev/stack.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CONSTANTS, SECRET_KEYS, renderText, templateVars } from './stack.mjs'

const CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config')

test('renderText substitutes known placeholders and leaves Go templates alone', () => {
  assert.equal(renderText('a ${X} {{.}} $b', { X: '1' }), 'a 1 {{.}} $b')
})

test('renderText rejects unknown placeholders', () => {
  assert.throws(() => renderText('${MISSING}', {}), /unknown placeholder/)
})

test('every template renders with the generated env', () => {
  const env = { ...CONSTANTS, ...Object.fromEntries(SECRET_KEYS.map((k) => [k, `secret-${k}`])) }
  const vars = templateVars(env)
  const templates = fs.readdirSync(CONFIG).filter((f) => f.endsWith('.tmpl'))
  assert.ok(templates.length >= 5)
  for (const t of templates) {
    const out = renderText(fs.readFileSync(path.join(CONFIG, t), 'utf8'), vars, t)
    assert.doesNotMatch(out, /\$\{[A-Z0-9_]+\}/, t)
  }
})

test('bridge config and registration agree on tokens and namespaces', () => {
  const env = { ...CONSTANTS, ...Object.fromEntries(SECRET_KEYS.map((k) => [k, `secret-${k}`])) }
  for (const x of ['demo', 'agents']) {
    const reg = renderText(fs.readFileSync(path.join(CONFIG, `registration-${x}.yaml.tmpl`), 'utf8'), env)
    const cfg = renderText(fs.readFileSync(path.join(CONFIG, `bridge-${x}.yaml.tmpl`), 'utf8'), env)
    const up = x.toUpperCase()
    for (const tok of [`secret-${up}_AS_TOKEN`, `secret-${up}_HS_TOKEN`]) {
      assert.ok(reg.includes(tok) && cfg.includes(tok), `${x}: ${tok}`)
    }
    assert.match(reg, new RegExp(`sender_localpart: ${x}bot`))
    assert.match(cfg, new RegExp(`username: ${x}bot`))
    assert.match(cfg, new RegExp(`username_template: ${x}_\\{\\{\\.\\}\\}`))
    assert.ok(reg.includes(`'^@${x}_.*:agentstudio\\.local$'`))
  }
})
