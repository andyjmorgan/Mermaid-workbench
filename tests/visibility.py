import os
from playwright.sync_api import sync_playwright, expect
with sync_playwright() as p:
 b=p.chromium.launch()
 for w,h in [(1440,900),(1024,768),(768,1024),(390,844)]:
  page=b.new_page(viewport={'width':w,'height':h})
  page.goto(os.environ.get('WORKSPACE_URL', 'http://127.0.0.1:31473'),wait_until='networkidle')
  expect(page.get_by_role('button',name='Toggle theme')).to_be_enabled(timeout=45000)
  f=page.frame_locator('iframe')
  editor=f.locator('.monaco-editor' if w>=640 else '.cm-editor').first
  expect(editor).to_be_visible()
  page.wait_for_timeout(500)
  box=editor.bounding_box()
  assert box['x']>=0 and box['x']+box['width']<=w,box
  if w<1024:
   expect(page.locator('aside')).to_have_count(0)
   page.get_by_role('button',name='Assistant',exact=True).click()
   expect(page.locator('aside')).to_be_visible()
   page.get_by_role('button',name='Back to editor').click()
   expect(page.locator('aside')).to_have_count(0)
  page.screenshot(path=f'/tmp/mermaid-fixed-{w}.png')
  print('PASS visible editor',w,box,flush=True)
  page.close()
 b.close()
