// worker.js — runs all computation off the main thread
// The main thread posts messages here; we compute and post results back.
// The browser's input handling is never blocked.

importScripts('/forecastEngine.js');

self.onmessage = function(e) {
  const { type, payload, id } = e.data;

  if (type === 'COMPUTE_RESULT') {
    // Compute whatever result the active tool needs
    try {
      const result = computeResult(payload);
      self.postMessage({ id, type: 'RESULT', result });
    } catch(err) {
      self.postMessage({ id, type: 'ERROR', error: err.message });
    }
  }

  if (type === 'COMPUTE_FORECAST') {
    try {
      const result = ForecastEngine.generateForecast(payload);
      self.postMessage({ id, type: 'FORECAST_RESULT', result });
    } catch(err) {
      self.postMessage({ id, type: 'ERROR', error: err.message });
    }
  }

  if (type === 'SAVE_DATA') {
    // Data serialization off the main thread too
    try {
      const serialized = JSON.stringify(payload);
      self.postMessage({ id, type: 'SAVE_READY', serialized });
    } catch(err) {
      self.postMessage({ id, type: 'ERROR', error: err.message });
    }
  }
};

function computeResult(payload) {
  const { tool, data } = payload;

  if (tool === 'truth') {
    const { revenue=0, expenses=0, ar=0, ap=0, bank=0 } = data;
    const r = Number(revenue)||0, ex = Number(expenses)||0;
    const a = Number(ar)||0, ap2 = Number(ap)||0, b = Number(bank)||0;
    const hasInput = revenue!=='' && expenses!=='' && bank!=='';
    if (!hasInput) return null;
    const paperProfit = r - ex;
    const realCash = b - ap2;
    const gap = paperProfit - realCash;
    let status, headline, story, action;
    if (Math.abs(gap) < Math.max(r * 0.05, 200)) {
      status='good'; headline='Your books and your bank account agree.';
      story=`You made ${fmt(paperProfit)} on paper, and your real cash position is close to that.`;
      action='Nothing urgent here. Keep doing your weekly cash check so it stays this way.';
    } else if (gap > 0) {
      status='watch'; headline=`You made ${fmt(paperProfit)} on paper, but only ${fmt(realCash)} is actually available.`;
      const rc = a > ap2 ? 'slow-paying customers' : 'spending ahead of incoming cash';
      story=`That ${fmt(gap)} gap usually comes down to one thing: ${rc}.`;
      action = a > ap2
        ? `Send reminders on your oldest 3 unpaid invoices today — you have ${fmt(a)} outstanding.`
        : `Hold off on one non-essential purchase this week and re-check in 7 days.`;
    } else {
      status='good'; headline='Your real cash position is stronger than your paper profit shows.';
      story="This can happen when you've collected on old invoices or front-loaded payments.";
      action='Use this cash cushion wisely — it may not repeat next month.';
    }
    return { status, headline, story, action };
  }

  if (tool === 'lag') {
    const cd = Number(data.customerDays)||0, sd = Number(data.supplierDays)||0;
    const p = Number(data.payroll)||0, c = Number(data.cash)||0;
    const hasInput = data.customerDays!=='' && data.supplierDays!=='';
    if (!hasInput) return null;
    const lagDays = cd - sd;
    const runway = p > 0 ? Math.round(c / (p/30)) : 999;
    let status, headline, story;
    if (lagDays <= 0) {
      status='good'; headline="You're paid before you have to pay others. That's rare — protect it.";
      story=`Customers pay in ${cd} days, faster than your ${sd}-day supplier terms.`;
    } else {
      status = lagDays > 20 ? 'bad' : 'watch';
      headline = `There's a ${lagDays}-day gap between paying out and getting paid.`;
      story = `With ${fmt(p)}/month in fixed costs, current cash covers ~${runway} days if income stopped.`;
    }
    return { status, headline, story, lagDays };
  }

  if (tool === 'pnl') {
    const r = Number(data.revenue)||0, c = Number(data.cogs)||0, o = Number(data.opex)||0;
    if (data.revenue === '') return null;
    const gp = r - c, gm = r > 0 ? gp/r*100 : 0;
    const np = gp - o, nm = r > 0 ? np/r*100 : 0;
    let status = nm >= 10 ? 'good' : nm >= 0 ? 'watch' : 'bad';
    let label = nm >= 10 ? 'Healthy' : nm >= 0 ? 'Watch' : 'Concerning';
    const story = `You brought in ${fmt(r)}. After ${fmt(c)} in direct costs, gross profit is ${fmt(gp)} (${gm.toFixed(1)}%). After ${fmt(o)} in operating expenses, net profit is ${fmt(np)} — a ${nm.toFixed(1)}% margin.`;
    return { status, label, grossProfit: gp, grossMargin: gm, netProfit: np, netMargin: nm, story };
  }

  if (tool === 'breakeven') {
    const f = Number(data.fixed)||0, p = Number(data.price)||0, c = Number(data.cost)||0;
    if (data.fixed === '' || data.price === '') return null;
    const margin = p - c;
    if (margin <= 0) return { headline: 'Your cost per unit is the same or higher than your price.', story: 'Every sale breaks even or loses money before fixed costs are covered.' };
    const units = Math.ceil(f / margin);
    const rev = units * p;
    return { headline: `You need ${units.toLocaleString()} sales (${fmt(rev)}) to break even each month.`, story: `Each sale earns ${fmt(margin)} after direct costs. ${units.toLocaleString()} sales covers your ${fmt(f)} in fixed costs.` };
  }

  if (tool === 'snapshot') {
    const r = Number(data.revenue)||0, ex = Number(data.expenses)||0;
    const ca = Number(data.cash)||0, ow = Number(data.owed)||0;
    if (data.revenue === '' || data.name === '') return null;
    return { net: r - ex, cash: ca, owed: ow, name: data.name, period: data.period, revenue: r, expenses: ex };
  }

  if (tool === 'forecast') {
    const ca = Number(data.cash)||0, inc = Number(data.income)||0, ex = Number(data.expenses)||0;
    if (data.cash === '' || data.income === '') return null;
    const net = inc - ex;
    const balances = [ca+net, ca+net*2, ca+net*3];
    const firstNeg = balances.findIndex(b => b < 0);
    const story = firstNeg === -1
      ? `Cash stays positive through all 90 days, ending around ${fmt(balances[2])}.`
      : `Cash turns negative in Month ${firstNeg+1} — around ${fmt(balances[firstNeg])}. Act now while there's still time.`;
    return { balances, firstNeg, story, startCash: ca };
  }

  return null;
}

function fmt(n) {
  const num = Number(n)||0;
  return (num < 0 ? '-$' : '$') + Math.abs(num).toLocaleString(undefined, {maximumFractionDigits:0});
}
