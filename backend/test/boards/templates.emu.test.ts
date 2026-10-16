/** templates.html §A: templateSave / templateDelete, and where templates are used. */
import { describe, expect, it } from 'vitest';
import { paths, TEMPLATE_STARTERS, type Template, type Ticket, type ViewInput } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { setupEmulators } from '../harness/index.js';
import { addMember, call, createUser, getViews, newBoard, uniqKey } from './helpers.js';

setupEmulators();

const tpl = async (boardId: string, id: string) => {
  const s = await db().doc(paths.template(boardId, id)).get();
  return s.exists ? (s.data() as Template) : undefined;
};

const kanban = (over: Partial<ViewInput> = {}): ViewInput => ({
  name: 'Cards',
  type: 'kanban',
  scope: 'shared',
  position: 9,
  filter: null,
  sort: [],
  groupBy: 'stage',
  subGroupBy: null,
  columns: [],
  dateField: null,
  endDateField: null,
  cardFields: [],
  includeStates: ['active'],
  ...over,
});

describe('templateSave / templateDelete', () => {
  it('admins create and update; the kind is fixed; others are refused', async () => {
    const alice = await createUser();
    const ed = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, ed, 'editor');

    const { templateId } = await call(alice, 'templateSave', {
      boardId,
      template: { kind: 'message', name: 'Bug report', code: TEMPLATE_STARTERS.message },
    });
    const saved = (await tpl(boardId, templateId))!;
    expect(saved).toMatchObject({
      kind: 'message',
      name: 'Bug report',
      description: null,
      createdBy: alice.uid,
      updatedBy: alice.uid,
    });

    await call(alice, 'templateSave', {
      boardId,
      templateId,
      template: {
        kind: 'message',
        name: 'Bug',
        code: 'export default {}',
        description: 'For bugs',
        indicator: { kind: 'emoji', emoji: '🐞' },
      },
    });
    const updated = (await tpl(boardId, templateId))!;
    expect(updated).toMatchObject({
      name: 'Bug',
      code: 'export default {}',
      description: 'For bugs',
      indicator: { kind: 'emoji', emoji: '🐞' },
      createdAt: saved.createdAt,
      position: saved.position,
    });

    await expect(
      call(alice, 'templateSave', {
        boardId,
        templateId,
        template: { kind: 'card', name: 'Bug', code: '' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      call(ed, 'templateSave', {
        boardId,
        template: { kind: 'message', name: 'Nope', code: '' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(call(ed, 'templateDelete', { boardId, templateId })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      call(alice, 'templateSave', {
        boardId,
        templateId: 'nope',
        template: { kind: 'message', name: 'X', code: '' },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await call(alice, 'templateDelete', { boardId, templateId });
    expect(await tpl(boardId, templateId)).toBeUndefined();
    await expect(call(alice, 'templateDelete', { boardId, templateId })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a view takes only a card template; deleting it puts the view back on the built-in card', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const card = await call(alice, 'templateSave', {
      boardId,
      template: { kind: 'card', name: 'Compact', code: TEMPLATE_STARTERS.card },
    });
    const msg = await call(alice, 'templateSave', {
      boardId,
      template: { kind: 'message', name: 'Msg', code: TEMPLATE_STARTERS.message },
    });
    await expect(
      call(alice, 'viewSave', { boardId, view: kanban({ cardTemplateId: msg.templateId }) }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(alice, 'viewSave', { boardId, view: kanban({ cardTemplateId: 'missing' }) }),
    ).rejects.toMatchObject({ code: 'invalid' });
    const { viewId } = await call(alice, 'viewSave', {
      boardId,
      view: kanban({ cardTemplateId: card.templateId }),
    });
    expect((await getViews(boardId)).find((v) => v.id === viewId)!.cardTemplateId).toBe(
      card.templateId,
    );
    await call(alice, 'templateDelete', { boardId, templateId: card.templateId });
    expect((await getViews(boardId)).find((v) => v.id === viewId)!.cardTemplateId).toBeNull();
  });

  it('copying a board copies its templates, and views follow them to the new ids', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const card = await call(alice, 'templateSave', {
      boardId,
      template: { kind: 'card', name: 'Compact', code: TEMPLATE_STARTERS.card },
    });
    await call(alice, 'viewSave', { boardId, view: kanban({ cardTemplateId: card.templateId }) });
    const { boardId: copyId } = await call(alice, 'boardCreate', {
      name: 'Copy',
      key: uniqKey(),
      template: { fromBoardId: boardId },
    });
    const copied = await db().collection(paths.templates(copyId)).get();
    expect(copied.docs.map((d) => (d.data() as Template).name)).toEqual(['Compact']);
    const newId = copied.docs[0]!.id;
    expect(newId).not.toBe(card.templateId);
    const view = (await getViews(copyId)).find((v) => v.name === 'Cards')!;
    expect(view.cardTemplateId).toBe(newId);
  });

  it('messagePost keeps the template and its data; an unknown template is refused', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const { templateId } = await call(alice, 'templateSave', {
      boardId,
      template: { kind: 'message', name: 'Bug report', code: TEMPLATE_STARTERS.message },
    });
    const board = (await db().doc(paths.board(boardId)).get()).data()!;
    const { ticketId } = await call(alice, 'ticketCreate', {
      boardId,
      title: 'Templates',
      stageId: board.stages[0].id,
    });
    const body = {
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bug · high' }] }],
    };
    await call(alice, 'messagePost', {
      boardId,
      ticketId,
      body,
      markdown: '**Bug** · high',
      template: { id: templateId, name: 'ignored', data: { severity: 'high' } },
      clientId: 'tplmsg1',
    });
    const t = (await db().doc(paths.ticket(boardId, ticketId)).get()).data() as Ticket;
    const m = t.recentMessages!.find((x) => x.id === 'tplmsg1')!;
    expect(m.template).toEqual({ id: templateId, name: 'Bug report', data: { severity: 'high' } });
    await expect(
      call(alice, 'messagePost', {
        boardId,
        ticketId,
        body,
        template: { id: 'missing', name: 'x' },
        clientId: 'tplmsg2',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});
