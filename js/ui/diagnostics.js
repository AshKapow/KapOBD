// Codes screen: stored / pending / permanent fault codes, freeze frame,
// readiness, and the clear-codes flow with its safeguards.
import { h, replace, messageBox, confirmButton } from './dom.js';
import { describeDtc, dtcSystem } from '../obd/dtc.js';
import { formatValue } from '../obd/pids.js';
import { ecuLabel } from '../vehicle.js';
import { readinessSummary, countCodes } from '../diagnostics.js';

export function renderDiagnostics(el, app) {
  const d = app.diag;
  const disabled = !!app.busy;
  replace(
    el,
    h('h2', {}, 'Fault codes'),
    messageBox(app),
    !app.connected
      ? h('p', { class: 'hint' }, 'Connect to your adapter first (or try the demo), then come back here to read the car’s fault codes.')
      : [
          app.clearFlow ? null : h('div', { class: 'actions' }, h('button', { class: 'btn big primary', disabled, onclick: () => app.runReadCodes() }, d ? 'Read codes again' : 'Read fault codes')),
          app.clearFlow ? clearFlowView(app, disabled) : null,
          d && !app.clearFlow ? results(app, d, disabled) : null,
        ],
  );
}

// --- results -------------------------------------------------------------------

function results(app, d, disabled) {
  const n = countCodes(d);
  const ready = readinessSummary(d.monitor);
  return [
    summaryCard(d, n, ready),
    readinessCard(ready),
    codeSection(app, 'Stored codes', 'Confirmed faults. These normally turn the engine warning light on.', d.stored, 'stored'),
    codeSection(app, 'Pending codes', 'Faults seen once but not yet confirmed. They may become stored codes or clear by themselves.', d.pending, 'pending'),
    codeSection(app, 'Permanent codes', 'Can’t be cleared with a scan tool. The car removes them itself once the fault is fixed and it has re-checked.', d.permanent, 'permanent'),
    d.freeze ? freezeCard(app, d.freeze) : null,
    clearOffer(app, n, ready, disabled),
  ];
}

function summaryCard(d, n, ready) {
  return h(
    'div',
    { class: 'card summary' },
    h('div', { class: 'lamp ' + (ready.mil ? 'on' : 'off') }, h('span', { class: 'dot' }), ready.mil ? 'Engine warning light ON' : 'Engine warning light off'),
    h(
      'div',
      { class: 'counts' },
      count(n.stored, 'stored'),
      count(n.pending, 'pending'),
      d.permanent.answered ? count(n.permanent, 'permanent') : h('div', { class: 'count muted' }, h('strong', {}, '–'), h('span', {}, 'permanent')),
    ),
    h('p', { class: 'hint' }, `Read at ${new Date(d.readAt).toLocaleTimeString()}.`),
  );
}

function count(n, label) {
  return h('div', { class: 'count' + (n ? ' has' : '') }, h('strong', {}, String(n)), h('span', {}, label));
}

const READY_TEXT = {
  ready: 'All of the car’s self-checks have completed.',
  almost: 'One self-check hasn’t completed yet.',
  'not-ready': 'Several self-checks haven’t completed yet.',
  unknown: 'The car didn’t report its self-checks.',
};

function readinessCard(ready) {
  return h(
    'details',
    { class: `card readiness ${ready.state}` },
    h('summary', {}, h('span', { class: 'dot' }), `Readiness: ${READY_TEXT[ready.state]}`),
    ready.monitors.length
      ? h('ul', { class: 'monitors' }, ready.monitors.map((m) => h('li', { class: m.status === 'ready' ? 'ready' : 'notready' }, `${m.name}: ${m.status}`)))
      : null,
    h(
      'p',
      { class: 'hint' },
      'Readiness monitors are the car’s own emissions self-checks. After codes are cleared or the battery is disconnected they reset to “not ready” and complete again over a few days of normal mixed driving. Some emissions inspections check them, and in the UK a lit engine warning light is an MOT failure.',
    ),
  );
}

function codeSection(app, title, help, section, kind) {
  let body;
  if (!section.answered) {
    body = h('p', { class: 'hint' }, kind === 'permanent' ? 'Not reported by this car (older cars don’t support permanent codes).' : `No reply (${section.error ?? 'no data'}). On some older cars this just means there are no codes.`);
  } else if (!section.codes.length) {
    body = h('p', { class: 'none' }, 'None');
  } else {
    body = h(
      'ul',
      { class: 'codes' },
      section.ecus.flatMap((e) =>
        e.codes.map((code) =>
          h(
            'li',
            { class: `code ${kind}` },
            h('code', {}, code),
            h('div', {}, h('div', { class: 'desc' }, describeDtc(code, app.dtcTable)), h('small', {}, `${dtcSystem(code)} · ${ecuLabel(e.ecu)}`)),
          ),
        ),
      ),
    );
  }
  return h('section', { class: 'card' }, h('h3', {}, title), h('p', { class: 'hint' }, help), body);
}

function freezeCard(app, f) {
  return h(
    'details',
    { class: 'card' },
    h('summary', {}, `Freeze frame for ${f.code}`),
    h('p', { class: 'hint' }, 'What the engine was doing at the moment this fault was stored.'),
    f.values.length
      ? h('dl', { class: 'kv' }, f.values.map((v) => [h('dt', {}, v.name), h('dd', {}, formatValue(v.pid, v.value))]))
      : h('p', { class: 'hint' }, 'The car didn’t return any freeze-frame values.'),
    h('p', { class: 'hint' }, `From ${ecuLabel(f.ecu)}.`),
  );
}

function clearOffer(app, n, ready, disabled) {
  const something = n.stored || n.pending || ready.mil;
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, 'Clear codes'),
    something
      ? [
          h('p', { class: 'hint' }, 'Turns the warning light off and erases stored and pending codes. It doesn’t fix anything. You’ll be taken through some checks first.'),
          h('button', { class: 'btn danger', disabled, onclick: () => app.startClear() }, 'Clear codes…'),
        ]
      : h('p', { class: 'hint' }, 'There’s nothing to clear.'),
  );
}

// --- clear-codes flow ----------------------------------------------------------

function clearFlowView(app, disabled) {
  const f = app.clearFlow;
  const cancel = h('button', { class: 'btn secondary', disabled, onclick: () => app.cancelClear() }, 'Cancel');
  const steps = ['warn', 'conditions', 'confirm'];
  const stepNo = steps.indexOf(f.step) + 1;
  const header = stepNo ? h('p', { class: 'step' }, `Clear codes: step ${stepNo} of 3`) : null;

  if (f.step === 'warn') {
    return h(
      'section',
      { class: 'card flow' },
      header,
      h('h3', {}, 'Before you clear codes'),
      h(
        'ul',
        { class: 'warnlist' },
        h('li', {}, h('strong', {}, 'It doesn’t fix the fault. '), 'It only turns the warning light off. If the fault is still there, the code and the light will come back.'),
        h('li', {}, h('strong', {}, 'It resets the readiness monitors. '), 'The car’s self-checks start again from scratch and take a few days of normal driving to complete.'),
        h('li', {}, h('strong', {}, 'An emissions test (such as an MOT) may fail '), 'or be refused until the car has been driven enough for the monitors to complete.'),
        h('li', {}, h('strong', {}, 'The freeze-frame data is lost, '), 'which a garage could use to diagnose the fault. Consider noting the codes first.'),
        h('li', {}, h('strong', {}, 'Permanent codes stay. '), 'Only the car can remove them, after the fault is fixed.'),
        h('li', {}, h('strong', {}, 'Some cars refuse. '), 'Cars with a security gateway may block clearing; KapOBD will tell you if that happens.'),
      ),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.understood, onchange: (e) => app.updateClear({ understood: e.target.checked }) }), 'I understand'),
      h('div', { class: 'actions' }, cancel, h('button', { class: 'btn primary', disabled: disabled || !f.understood, onclick: () => app.updateClear({ step: 'conditions' }) }, 'Continue')),
    );
  }

  if (f.step === 'conditions') {
    const c = f.check;
    return h(
      'section',
      { class: 'card flow' },
      header,
      h('h3', {}, 'Engine off, ignition on'),
      h(
        'ol',
        {},
        h('li', {}, 'Park the car and switch the engine off.'),
        h('li', {}, 'Turn the ignition on without starting the engine. With a start button, press it without touching the brake or clutch pedal.'),
        h('li', {}, h('strong', {}, 'Hybrids: '), 'make sure the car is not in “READY” mode, or the engine may start by itself.'),
      ),
      h('button', { class: 'btn', disabled, onclick: () => app.runClearCheck() }, c ? 'Check again' : 'Check the car'),
      c
        ? c.problems.length
          ? h('div', { class: 'msg error' }, c.problems.map((p) => h('div', {}, p)))
          : h(
              'div',
              { class: 'msg ok' },
              `Engine speed: ${c.rpm == null ? 'not reported' : `${Math.round(c.rpm)} rpm`}. Road speed: ${c.speed == null ? 'not reported' : formatValue(0x0d, c.speed)}.`,
              c.rpm == null ? h('div', { class: 'sub' }, 'The car didn’t report engine speed, which is common with the engine stopped. Please check yourself.') : null,
            )
        : null,
      c && !c.problems.length
        ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.engineOffConfirmed, onchange: (e) => app.updateClear({ engineOffConfirmed: e.target.checked }) }), 'The engine is off and the ignition is on')
        : null,
      h(
        'div',
        { class: 'actions' },
        cancel,
        h('button', { class: 'btn primary', disabled: disabled || !c || c.problems.length > 0 || !f.engineOffConfirmed, onclick: () => app.updateClear({ step: 'confirm' }) }, 'Continue'),
      ),
    );
  }

  if (f.step === 'confirm') {
    const n = countCodes(app.diag);
    return h(
      'section',
      { class: 'card flow' },
      header,
      h('h3', {}, 'Clear the codes?'),
      h('p', {}, `This will ask the car to erase ${n.stored} stored and ${n.pending} pending code(s) and turn off the warning light. It’s sent once; KapOBD then reads the codes again to check.`),
      h(
        'div',
        { class: 'actions wrap' },
        cancel,
        confirmButton('Clear codes now', () => app.runClear(), { class: 'btn danger', armedLabel: 'Tap again to clear codes', ms: 6000 }),
      ),
    );
  }

  if (f.step === 'sending') return h('section', { class: 'card flow' }, h('h3', {}, 'Clearing…'));

  // result
  return h('section', { class: 'card flow' }, resultView(f.outcome), h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => app.cancelClear() }, 'Done')));
}

function resultView(o) {
  if (!o) return [h('h3', {}, 'Something went wrong'), h('p', {}, 'The clear request could not be completed. Copy the log from the Console screen if you want to report it.')];
  const left = countCodes(o.after);
  const detail = o.detail?.length ? h('p', { class: 'hint' }, `Car’s reply: ${o.detail.join('; ')}`) : null;
  switch (o.status) {
    case 'cleared':
    case 'partial':
      if (o.verified) {
        return [
          h('h3', { class: 'good' }, 'Codes cleared'),
          h('p', {}, `The car confirmed, and a fresh read shows no stored or pending codes.${left.permanent ? ` ${left.permanent} permanent code(s) remain until the car re-checks the repaired system.` : ''}`),
          o.status === 'partial' ? h('p', { class: 'hint' }, 'Some of the car’s computers refused; their codes may remain.') : null,
          h('p', { class: 'hint' }, 'The readiness monitors now show “not ready”. That’s expected; they complete over a few days of normal driving.'),
          detail,
        ];
      }
      return [
        h('h3', { class: 'warn' }, 'Cleared, but codes came back'),
        h('p', {}, `The car accepted the request, but a fresh read still shows ${left.stored} stored and ${left.pending} pending code(s). The fault is probably still present.`),
        detail,
      ];
    case 'refused':
      return [
        h('h3', { class: 'bad' }, 'The car refused to clear the codes'),
        h('p', {}, 'This car’s security gateway (or engine computer) blocked clearing. A dealer or a gateway-authorised tool is needed to clear these codes. Nothing was changed.'),
        detail,
      ];
    case 'no-response':
      return [
        h('h3', { class: 'bad' }, 'No reply to the clear request'),
        h('p', {}, 'The car didn’t answer. On cars with a security gateway this usually means clearing is blocked; a dealer or gateway-authorised tool is needed. KapOBD won’t try again automatically.'),
        h('p', { class: 'hint' }, `A fresh read shows ${left.stored} stored and ${left.pending} pending code(s).`),
      ];
    default:
      return [h('h3', { class: 'bad' }, 'Clearing failed'), h('p', {}, `The adapter reported an error (${o.detail?.join('; ') || 'unknown'}). Nothing was retried.`)];
  }
}

