import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { tickets, views } from './fixtures';

const q = new URLSearchParams(location.search);
const which = (q.get('view') ?? 'board') as keyof typeof views;
const dark = q.get('theme') === 'dark';
let mode: 'inline' | 'fullscreen' = q.get('mode') === 'fullscreen' ? 'fullscreen' : 'inline';
if (dark) document.body.classList.add('dark');
document.body.classList.toggle('full', mode === 'fullscreen');

const frame = document.getElementById('view') as HTMLIFrameElement;
const log = (s: string) => (document.getElementById('log')!.textContent += s + '\n');
const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});

const context = () => ({
  theme: dark ? ('dark' as const) : ('light' as const),
  displayMode: mode,
  availableDisplayModes: ['inline' as const, 'fullscreen' as const],
  safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
});

frame.addEventListener('load', async () => {
  const bridge = new AppBridge(
    null,
    { name: 'harness', version: '0' },
    { openLinks: {}, serverTools: {} },
    { hostContext: context() },
  );
  bridge.oncalltool = async ({ name, arguments: a }) => {
    log(`tool ${name} ${JSON.stringify(a)}`);
    if (name === 'show_board') return ok(views.board());
    if (name === 'show_ticket') return ok(views.ticket(String(a?.key)));
    if (name === 'show_my_work') return ok(views.mywork());
    if (name === 'move_ticket') {
      const t = tickets.find((x) => x.key === a?.key);
      if (t) t.stage = String(a?.stage);
    }
    return ok({ ok: true });
  };
  bridge.onrequestdisplaymode = async ({ mode: m }) => {
    mode = m === 'fullscreen' ? 'fullscreen' : 'inline';
    document.body.classList.toggle('full', mode === 'fullscreen');
    bridge.setHostContext(context());
    return { mode };
  };
  bridge.onopenlink = async ({ url }) => (log(`open ${url}`), {});
  bridge.onmessage = async (p) => (log(`message ${JSON.stringify(p.content)}`), {});
  bridge.onsizechange = ({ height }) => {
    if (mode === 'inline' && height) frame.style.height = `${height}px`;
  };
  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: {} });
    void bridge.sendToolResult(ok(views[which]()));
  };
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
});
