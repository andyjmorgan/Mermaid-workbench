import os
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
URL=os.environ.get('WORKSPACE_URL','http://127.0.0.1:31473')
with sync_playwright() as p:
 b=p.chromium.launch()
 page=b.new_page(viewport={'width':1680,'height':1050})
 page.goto(URL,wait_until='networkidle')
 expect(page.get_by_role('button',name='New',exact=True)).to_be_enabled(timeout=45000)
 f=page.frame_locator('iframe')
 expect(f.get_by_role('link',name='Docs',exact=True)).to_have_count(0)
 f.locator('.monaco-editor .view-line').first.hover()
 expect(f.locator('.suggestion-icon')).to_have_count(0)
 for name in ['Documentation','Community','Mermaid.js','Edit in Playground','Plugins']:
  expect(f.get_by_role('link',name=name,exact=True)).to_have_count(0)
 with page.expect_popup() as popup:
  page.get_by_role('button',name='New',exact=True).click()
 new=popup.value
 new.wait_for_load_state('networkidle')
 expect(new.get_by_text('Mermaid workspace',exact=True)).to_be_visible()
 assert urlsplit(new.url).path=='/'
 new.close()
 with page.expect_popup() as popup:
  page.get_by_role('button',name='Duplicate',exact=True).click()
 duplicate=popup.value
 duplicate.wait_for_load_state('networkidle')
 expect(duplicate.get_by_text('Mermaid workspace',exact=True)).to_be_visible()
 assert urlsplit(duplicate.url).path=='/' and urlsplit(duplicate.url).fragment
 duplicate.close()
 page.keyboard.press('Escape')
 f.get_by_text('Actions',exact=True).click()
 expect(f.get_by_role('button',name='Kroki',exact=True)).to_have_count(0)
 links=f.locator('a[href*="/render/"]').evaluate_all('(els)=>els.map(e=>e.href)')
 assert len(links)==2,links
 for link in links:
  assert link.startswith('https://mermaid.donkeywork.dev/render/'),link
  url=urlsplit(link)
  response=page.request.get(URL+url.path+'?'+url.query,timeout=60000)
  assert response.ok,(response.status,response.text()[:200])
  assert response.headers['content-type'].startswith('image/'),response.headers
  print('PASS hosted image',response.headers['content-type'],len(response.body()),flush=True)
 for kind in ['PNG','SVG']:
  with page.expect_download() as info:
   f.get_by_test_id('download-'+kind).click()
  assert info.value.failure() is None
 print('PASS New/Duplicate preserve wrapper, hover AI and promotional links removed, local downloads',flush=True)
 page.screenshot(path='/tmp/mermaid-clean-workspace.png')
 b.close()
