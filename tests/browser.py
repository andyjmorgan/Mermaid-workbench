"""Run against an already running workspace: WORKSPACE_URL=http://... python tests/browser.py."""
import json, os
from playwright.sync_api import sync_playwright, expect
URL=os.environ.get('WORKSPACE_URL','http://127.0.0.1:31473')

def complete(route, output):
    events=[]
    for i,item in enumerate(output):
        events.append({'type':'response.output_item.added','output_index':i,'item':item})
    events.append({'type':'response.completed','response':{'status':'completed','output':output,'usage':{'input_tokens':20,'output_tokens':10}}})
    route.fulfill(status=200,content_type='text/event-stream',body=''.join('data: '+json.dumps(e)+'\n\n' for e in events))

def tool(call,name,args):
    return {'type':'function_call','id':'fc_'+call,'call_id':call,'name':name,'arguments':json.dumps(args),'status':'completed'}

def message(text):
    return {'type':'message','id':'msg_done','role':'assistant','status':'completed','content':[{'type':'output_text','text':text}]}

def edit(page,code):
    frame=page.frame_locator('iframe')
    frame.locator('.monaco-editor .view-lines').first.click()
    page.keyboard.press('Control+a');page.keyboard.insert_text(code)

def send(page,text):
    page.get_by_role('textbox',name='Message to Gemma').fill(text)
    page.get_by_role('button',name='Send',exact=True).click()
    page.get_by_role('button',name='Stop',exact=True).wait_for()

def finished(page):
    page.get_by_role('button',name='Stop',exact=True).wait_for(state='hidden',timeout=45000)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    context=browser.new_context(viewport={'width':1680,'height':1100},permissions=['clipboard-read','clipboard-write'])
    page=context.new_page();seen=[]
    def route(request):
        data=request.request.post_data_json;seen.append(data)
        if len(seen)==1:
            complete(request,[{'type':'reasoning','id':'rs_1','summary':[{'type':'summary_text','text':'Keep the existing nodes and add Review.'}]},tool('code1','edit_code',{'code':'flowchart LR\n A[Latest manual edit] --> B[Review]'}),tool('config1','edit_config',{'config':'{"theme":"forest"}'})])
        else: complete(request,[message('Updated the diagram and its theme.')])
    page.route('**/api/responses',route)
    page.goto(URL,wait_until='networkidle')
    page.frame_locator('iframe').locator('#container svg').wait_for()
    edit(page,'flowchart LR\n A[Latest manual edit]')
    send(page,'Add a review step and use forest')
    finished(page)
    companion=json.loads(seen[0]['input'][-1]['content'])
    assert 'Latest manual edit' in companion['current_code']
    assert companion['user_message']=='Add a review step and use forest'
    results=[i for i in seen[1]['input'] if i.get('type')=='function_call_output']
    assert len(results)==2
    assert all(json.loads(i['output'])['success'] for i in results),results
    assert json.loads(json.loads(results[-1]['output'])['current_config'])['theme']=='forest'
    card=page.get_by_test_id('tool-card').first
    card.locator('summary').click()
    card.get_by_role('button',name='Copy code',exact=True).click()
    assert 'Latest manual edit' in page.evaluate('navigator.clipboard.readText()')
    card.get_by_role('button',name='Copy request',exact=True).click()
    assert json.loads(page.evaluate('navigator.clipboard.readText()'))['code'].startswith('flowchart')
    page.get_by_role('button',name='Copy message').last.click()
    assert page.evaluate('navigator.clipboard.readText()')=='Updated the diagram and its theme.'
    page.reload(wait_until='networkidle')
    expect(page.locator('aside')).to_contain_text('Add a review step and use forest')
    send(page,'Explain the current diagram')
    finished(page)
    latest=json.loads([i for i in seen[-1]['input'] if i.get('role')=='user'][-1]['content'])
    assert 'Review' in latest['current_code']
    assert json.loads(latest['current_config'])['theme']=='forest'
    assert len([i for i in seen[-1]['input'] if i.get('role')=='user'])==2
    print('PASS live manual context, both tools, copy fields, session reload, multi-turn history')
    page.get_by_role('button',name='Toggle theme').click()
    page.wait_for_function("document.documentElement.classList.contains('dark')")
    page.wait_for_timeout(300)
    textarea=page.get_by_role('textbox',name='Message to Gemma')
    bg=textarea.evaluate('(el)=>getComputedStyle(el).backgroundColor')
    assert bg!='rgb(255, 255, 255)',bg
    page.get_by_test_id('tool-card').first.locator('summary').click()
    page.screenshot(path='/tmp/mermaid-panel-dark.png',full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    page.screenshot(path='/tmp/mermaid-panel-mobile.png',full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
    page.get_by_role('button',name='Hide assistant').click()
    expect(page.locator('aside')).to_have_count(0)
    page.get_by_role('button',name='Assistant',exact=True).click()
    expect(page.locator('aside')).to_be_visible()
    print('PASS dark theme and mobile layout')
    context.close()

    context=browser.new_context(viewport={'width':1680,'height':1100})
    page=context.new_page();pending=[]
    page.route('**/api/responses',lambda r:pending.append(r))
    page.goto(URL,wait_until='networkidle');page.frame_locator('iframe').locator('#container svg').wait_for()
    send(page,'Replace the diagram')
    page.wait_for_timeout(1000)
    assert pending
    edit(page,'flowchart LR\n A[Preserve this manual edit]')
    complete(pending.pop(),[tool('conflict','edit_code',{'code':'flowchart LR\n A[Do not overwrite]'})])
    finished(page)
    expect(page.locator('aside')).to_contain_text('Your manual edits were preserved')
    assert 'Preserve this manual edit' in page.frame_locator('iframe').locator('#container svg').text_content()
    assert 'Do not overwrite' not in page.frame_locator('iframe').locator('#container svg').text_content()
    print('PASS edits made during inference are not overwritten')
    send(page,'Wait a moment')
    page.wait_for_timeout(1000)
    page.get_by_role('button',name='Stop',exact=True).click();finished(page)
    expect(page.locator('aside')).to_contain_text('Stopped.')
    page.get_by_role('button',name='New chat').click()
    history=page.evaluate('JSON.parse(sessionStorage.getItem("donkeywork-mermaid-chat-v1"))')
    assert history=={'input':[],'turns':[]}
    print('PASS stop and frontend history clear')
    for request in pending:
        try: request.abort()
        except Exception: pass
    context.close();browser.close()
