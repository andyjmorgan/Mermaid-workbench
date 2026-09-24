"""Duplicate must navigate even when source-tab timers are suspended."""
import os
from playwright.sync_api import sync_playwright, expect
URL=os.environ.get('WORKSPACE_URL','http://127.0.0.1:31473')
with sync_playwright() as p:
 for engine in ['chromium','firefox']:
  b=getattr(p,engine).launch()
  page=b.new_page(viewport={'width':1440,'height':900})
  page.goto(URL,wait_until='networkidle')
  expect(page.get_by_role('button',name='Duplicate',exact=True)).to_be_enabled(timeout=45000)
  page.evaluate('''() => {
    const original = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => delay === 400 ? 0 : original(callback, delay, ...args);
  }''')
  with page.expect_popup() as opened:
   page.get_by_role('button',name='Duplicate',exact=True).click()
  duplicate=opened.value
  expect(duplicate.get_by_text('Mermaid workspace',exact=True)).to_be_visible(timeout=30000)
  assert duplicate.url.startswith(URL+'/#'),duplicate.url
  expect(duplicate.frame_locator('iframe').locator('#container svg')).to_be_visible(timeout=30000)
  assert duplicate.evaluate('window.opener === null')
  print('PASS',engine,'duplicate opens workspace with snapshot timers suspended',flush=True)
  duplicate.close()
  page.reload(wait_until='networkidle')
  expect(page.get_by_role('button',name='Duplicate',exact=True)).to_be_enabled(timeout=45000)
  frame=page.frame_locator('iframe')
  frame.locator('.monaco-editor .view-lines').first.click()
  page.keyboard.press('Control+a')
  page.keyboard.insert_text('flowchart LR\n A[Immediately typed source] --> B[Copied]')
  with page.expect_popup() as opened:
   page.get_by_role('button',name='Duplicate',exact=True).click()
  duplicate=opened.value
  expect(duplicate.get_by_text('Mermaid workspace',exact=True)).to_be_visible(timeout=30000)
  expect(duplicate.frame_locator('iframe').locator('.monaco-editor .view-lines').first).to_contain_text('Immediately typed source',timeout=30000)
  print('PASS',engine,'duplicate retains input immediately before click',flush=True)
  b.close()
