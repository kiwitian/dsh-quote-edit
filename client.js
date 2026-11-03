/**
 * Client half of the 引用编辑 bundle.
 *
 * 选中回复或文档里的文字 → 选区上方浮出「AI 编辑」→ 写下这一处要改什么 →
 * 引用原文和调整意见一起落到主输入框的草稿里，可以连着引用好几处，最后一起发。
 *
 * 两条通道：
 * - shell.overlay 里的悬浮层负责选区侦测和弹层（浮层在最上层，不会被聊天列的滚动容器裁掉）。
 * - conversation.input.dock 里挂一个不可见的入口，把 composer 的 InputActions 交给悬浮层用。
 *   插入只走 `captureInsertion()` + `insertText()` 这一对官方接口，不模拟键盘、不碰编辑器内部。
 */
window.__ModuleLoader__.load({
  id: '@kiwitian/dsh-quote-edit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'quote-edit';
    const MARK = 'data-quote-edit';
    const COMPOSER_CARD = '[data-composer-card]';

    const ZH = {
      pill: 'AI 编辑',
      pillHint: '引用选中的文字，写下这一处要改什么',
      dialog: '引用到输入框',
      from: '引用',
      placeholder: '这一处想怎么改？',
      hint: 'Enter 插入 · Esc 取消',
      insert: '插入',
      busy: '输入框暂时不能写入，稍后再试',
    };

    const EN = {
      pill: 'AI edit',
      pillHint: 'Quote the selected text and note what should change',
      dialog: 'Quote into the composer',
      from: 'Quote',
      placeholder: 'What should change here?',
      hint: 'Enter inserts · Esc cancels',
      insert: 'Insert',
      busy: 'The composer cannot take text right now; try again.',
    };

    /** Filled by the dock entry while a session's composer is mounted. */
    const bridge = { insert: null };

    const CSS = [
      '.qe-root{position:fixed;z-index:2147483000;pointer-events:auto;left:0;top:0}',
      '.qe-pill{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'font-family:inherit;font-size:13px;line-height:1;font-weight:500;white-space:nowrap;cursor:pointer;user-select:none;',
      'box-shadow:0 6px 20px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)}',
      '.qe-pill:hover{background:var(--dsw-alias-bg-overlay)}',
      '.qe-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.qe-pill svg{color:var(--dsw-alias-brand-primary);transform:translateY(1px)}',
      '.qe-panel{box-sizing:border-box;width:340px;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-family:inherit;',
      'box-shadow:0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent)}',
      '.qe-head{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.qe-head svg{flex:none;color:var(--dsw-alias-brand-primary)}',
      '.qe-head-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.qe-quote{margin:0;padding:6px 8px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 40%, var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary-new-color, var(--dsw-static-blue-500));',
      'font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;',
      '-webkit-line-clamp:3;overflow:hidden}',
      '.qe-input{box-sizing:border-box;width:100%;min-height:52px;resize:none;padding:6px 8px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'font-family:inherit;font-size:13px;line-height:19px}',
      '.qe-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary-new-color, var(--dsw-static-blue-500))}',
      '.qe-input::placeholder{color:var(--dsw-alias-state-idle-primary)}',
      '.qe-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;line-height:16px;',
      'color:var(--dsw-alias-label-secondary)}',
      '.qe-hint{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.qe-hint.qe-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.qe-action{flex:none;height:26px;padding:0 10px;border-radius:6px;border:1px solid transparent;background:transparent;',
      'color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:12px;font-weight:600;cursor:pointer}',
      '.qe-action:hover{background:var(--dsw-alias-bg-overlay)}',
      '.qe-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    ].join('');

    /** The nearest element for a selection endpoint. */
    function elementOf(node) {
      if (!node) return null;
      if (node.nodeType === 1) return node;
      return node.parentElement || null;
    }

    /** Upper bound for the inline quote, so one line stays scannable at a glance. */
    const QUOTE_INLINE_LENGTH = 30;
    /** Punctuation a shortened quote may stop before, instead of cutting a phrase in half. */
    const CUT_MARKS = ['，', '。', '；', '：', '、', '！', '？', ',', '.', ';', ':', '!', '?'];

    /** Collapse a selection to one line and trim it to the inline budget. */
    function inlineQuote(text) {
      const flat = text.replace(/\s+/g, ' ').trim();
      const chars = Array.from(flat);
      if (chars.length <= QUOTE_INLINE_LENGTH) return flat;
      let cut = QUOTE_INLINE_LENGTH;
      for (let index = QUOTE_INLINE_LENGTH - 1; index >= 12; index -= 1) {
        if (CUT_MARKS.indexOf(chars[index]) !== -1) {
          cut = index;
          break;
        }
      }
      return chars.slice(0, cut).join('').replace(/\s+$/, '') + '…';
    }

    /** One line per quote: 【原文…】改动意见 */
    function composeQuote(pick, note) {
      const noteText = (note || '').trim();
      return '【' + inlineQuote(pick.text) + '】' + noteText + '\n\n';
    }

    /**
     * Read the live selection into the shape the pill needs.
     * @returns the pick, or null when there is nothing worth quoting.
     */
    function readPick() {
      if (bridge.insert === null) return null;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
      const text = selection.toString();
      if (text.trim() === '') return null;
      let range;
      try {
        range = selection.getRangeAt(0);
      } catch (error) {
        return null;
      }
      const element = elementOf(range.commonAncestorContainer);
      if (element === null) return null;
      if (element.closest(COMPOSER_CARD)) return null;
      if (element.closest('[' + MARK + ']')) return null;
      const rects = range.getClientRects();
      const box = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (!box || (box.width === 0 && box.height === 0)) return null;
      return {
        text,
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        width: box.width,
      };
    }

    /** Viewport placement for the pill and, once open, the panel. */
    function place(pick, opened) {
      const width = opened ? 340 : 132;
      const half = width / 2;
      const viewport = window.innerWidth || 1024;
      const anchor = pick.left + Math.min(pick.width, 280) / 2;
      const center = Math.max(half + 8, Math.min(anchor, viewport - half - 8));
      const above = pick.top >= (opened ? 210 : 56);
      return {
        left: Math.round(center) + 'px',
        top: Math.round(above ? pick.top - 8 : pick.bottom + 8) + 'px',
        transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      };
    }

    function Sparkle(props) {
      const size = props.size || 14;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      }, h('path', {
        d: 'M8 1.4l1.55 4.05L13.6 7 9.55 8.55 8 12.6 6.45 8.55 2.4 7l4.05-1.55z',
        fill: 'currentColor',
      }));
    }

    function createSelectionQuote(translate) {
      return function SelectionQuote() {
        const [pick, setPick] = React.useState(null);
        const [open, setOpen] = React.useState(false);
        const [note, setNote] = React.useState('');
        const [flash, setFlash] = React.useState('');
        const rootRef = React.useRef(null);

        React.useEffect(() => {
          let frame = 0;
          const update = () => {
            frame = 0;
            setPick(readPick());
          };
          const schedule = () => {
            if (open || frame !== 0) return;
            frame = requestAnimationFrame(update);
          };
          const hide = () => {
            if (open) return;
            setPick(null);
          };
          document.addEventListener('selectionchange', schedule);
          document.addEventListener('scroll', hide, true);
          window.addEventListener('resize', hide);
          return () => {
            if (frame !== 0) cancelAnimationFrame(frame);
            document.removeEventListener('selectionchange', schedule);
            document.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
          };
        }, [open]);

        React.useEffect(() => {
          if (!open) return undefined;
          const onPointerDown = (event) => {
            if (rootRef.current && rootRef.current.contains(event.target)) return;
            setOpen(false);
            setNote('');
            setFlash('');
            setPick(null);
          };
          document.addEventListener('mousedown', onPointerDown, true);
          return () => document.removeEventListener('mousedown', onPointerDown, true);
        }, [open]);

        if (pick === null) return null;

        const submit = () => {
          const accept = bridge.insert;
          const ok = typeof accept === 'function' ? accept(composeQuote(pick, note)) : false;
          if (!ok) {
            setFlash(translate('busy'));
            return;
          }
          setOpen(false);
          setNote('');
          setFlash('');
          setPick(null);
          const selection = window.getSelection();
          if (selection) selection.removeAllRanges();
        };

        const style = place(pick, open);
        const body = open
          ? h('div', { className: 'qe-panel', role: 'dialog', 'aria-label': translate('dialog') },
            h('div', { className: 'qe-head' },
              h(Sparkle, { size: 13 }),
              h('span', { className: 'qe-head-text' },
                translate('from')),
            ),
            h('div', { className: 'qe-quote' }, pick.text),
            h('textarea', {
              className: 'qe-input',
              value: note,
              rows: 2,
              autoFocus: true,
              spellCheck: false,
              placeholder: translate('placeholder'),
              onChange: (event) => {
                setNote(event.target.value);
                if (flash !== '') setFlash('');
              },
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setOpen(false);
                  setNote('');
                  setFlash('');
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  if (event.nativeEvent && event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  submit();
                }
              },
            }),
            h('div', { className: 'qe-foot' },
              h('span', { className: flash ? 'qe-hint qe-warn' : 'qe-hint' },
                flash !== '' ? flash : translate('hint')),
              h('button', {
                type: 'button',
                className: 'qe-action',
                onClick: submit,
              }, translate('insert')),
            ),
          )
          : h('button', {
            type: 'button',
            className: 'qe-pill',
            title: translate('pillHint'),
            'aria-label': translate('pillHint'),
            onMouseDown: (event) => {
              event.preventDefault();
            },
            onClick: () => {
              setOpen(true);
              setNote('');
              setFlash('');
            },
          },
          h(Sparkle, { size: 14 }),
          h('span', null, translate('pill')),
          );

        return h(React.Fragment, null,
          h('style', { key: 'style' }, CSS),
          h('div', {
            key: 'root',
            ref: rootRef,
            className: 'qe-root',
            [MARK]: 'root',
            style: { left: style.left, top: style.top, transform: style.transform },
          }, body),
        );
      };
    }

    function InserterBridge(props) {
      const actions = props.inputActions;
      React.useEffect(() => {
        if (!actions
          || typeof actions.insertText !== 'function'
          || typeof actions.captureInsertion !== 'function') {
          return undefined;
        }
        const insert = (text) => {
          try {
            return actions.insertText(text, actions.captureInsertion()) === true;
          } catch (error) {
            console.error('[quote-edit] insert failed', error);
            return false;
          }
        };
        bridge.insert = insert;
        return () => {
          if (bridge.insert === insert) bridge.insert = null;
        };
      }, [actions]);
      return null;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale');
        if (locale) {
          try {
            locale.register(NS, { zh: ZH, en: EN });
          } catch (error) {
            console.error('[quote-edit] locale registration failed', error);
          }
        }
        let bound = null;
        if (locale) {
          try {
            bound = locale.bind(NS);
          } catch (error) {
            bound = null;
          }
        }
        const translate = (key) => {
          if (bound) {
            try {
              const value = bound(key);
              if (typeof value === 'string' && value !== '' && value !== key) return value;
            } catch (error) {
              /* fall back to the Chinese default */
            }
          }
          return ZH[key] || key;
        };

        const SelectionQuote = createSelectionQuote(translate);
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'quote-edit.pill',
          order: 900,
        }, SelectionQuote));
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'quote-edit.bridge',
          order: 950,
        }, InserterBridge));
      },
    };
  },
});
