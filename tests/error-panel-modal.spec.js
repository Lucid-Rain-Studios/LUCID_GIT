const { test, expect } = require('@playwright/test')
const { chromium } = require('playwright')
const fs = require('fs')
let server, browser, page, url
test.setTimeout(30_000)

test.beforeAll(async () => {
  const { createServer } = await import('vite')
  server = await createServer({
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { entries: ['tests/fixtures/error-panel.html'] },
  })
  await server.listen()
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/error-panel.html`
  browser = await chromium.launch(fs.existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' })
})
test.beforeEach(async () => {
  page = await browser.newPage()
  page.on('pageerror', error => console.error('Fixture error:', error.message))
  await page.goto(url)
})
test.afterEach(async () => { await page?.close() })
test.afterAll(async () => { await browser?.close(); await server?.close() })

test('warning Close is clickable over a merge dialog and restores the merge controls', async () => {
  await page.setViewportSize({ width: 768, height: 486 })
  await page.getByRole('button', { name: 'Open merge with warning', exact: true }).click()
  const dismiss = page.getByTitle('Dismiss', { exact: true })
  await expect(dismiss).toBeVisible()
  await dismiss.click({ timeout: 3000 })
  await expect(dismiss).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open merge', exact: true })).toBeEnabled()
})

test('late warnings contain Tab and Escape, then restore focus and background inertness', async () => {
  await page.getByRole('button', { name: 'Open merge', exact: true }).click()
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
  await cancel.focus()
  await page.evaluate(() => window.showWarning())
  const warning = page.getByRole('dialog', { name: 'Error notification', exact: true })
  await expect(warning).toBeVisible()
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab')
    expect(await warning.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(warning).toHaveCount(0)
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(cancel).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open merge', exact: true })).toBeFocused()
})

test('a confirmation opened over a warning stays clickable and restores warning focus', async () => {
  await page.getByRole('button', { name: 'Open merge with warning', exact: true }).click()
  const dismiss = page.getByTitle('Dismiss', { exact: true })
  await dismiss.focus()
  await page.evaluate(() => { void window.showConfirmation() })
  const confirm = page.getByRole('dialog', { name: 'Confirm repair' })
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dismiss).toBeFocused()
  await dismiss.click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('removing a lower dialog keeps the top confirmation active and preserves prior inert state', async () => {
  await page.evaluate(() => {
    const blocked = document.createElement('button')
    blocked.textContent = 'Already blocked'; blocked.inert = true
    document.body.append(blocked)
  })
  await page.getByRole('button', { name: 'Open merge with warning', exact: true }).click()
  await page.evaluate(() => { void window.showConfirmation() })
  const cancel = page.getByRole('dialog', { name: 'Confirm repair' }).getByRole('button', { name: 'Cancel', exact: true })
  await expect(cancel).toBeFocused()
  await page.evaluate(() => window.closeMergeDialog())
  await expect(cancel).toBeFocused()
  await cancel.click()
  await page.getByTitle('Dismiss', { exact: true }).click()
  expect(await page.locator('#root').evaluate(el => el.inert)).toBe(false)
  expect(await page.getByText('Already blocked').evaluate(el => el.inert)).toBe(true)
  await page.getByRole('button', { name: 'Open merge', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
})
