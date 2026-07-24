// forecastEngine.js
// Core logic: takes historical periods of all 3 statements, computes trends,
// projects forward, and generates a plain-English cross-statement narrative.

/**
 * Linear regression: given an array of {x, y} points, returns {slope, intercept}.
 * Used to find the trend line through historical data for any line item.
 */
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0] ? points[0].y : 0 };
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * Projects a single line item forward using its historical trend.
 * historicalValues: array of numbers, oldest first.
 * periodsAhead: how many future periods to project.
 * Returns array of projected values.
 */
function projectLineItem(historicalValues, periodsAhead) {
  const points = historicalValues.map((y, x) => ({ x, y }));
  const { slope, intercept } = linearRegression(points);
  const lastX = historicalValues.length - 1;
  const projections = [];
  for (let i = 1; i <= periodsAhead; i++) {
    const x = lastX + i;
    projections.push(Math.round((slope * x + intercept) * 100) / 100);
  }
  return projections;
}

/**
 * Computes percent growth rate between the first and last historical value,
 * annualized-agnostic (just per-period average growth).
 */
function averageGrowthRate(values) {
  if (values.length < 2) return 0;
  const growthRates = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    if (prev !== 0) growthRates.push((curr - prev) / Math.abs(prev));
  }
  if (growthRates.length === 0) return 0;
  return growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
}

/**
 * Main forecast function.
 * input: {
 *   periodType: 'monthly' | 'quarterly',
 *   periodsAhead: 3 | 6 | 12,
 *   incomeStatement: [{ revenue, cogs, opex }, ...],   // oldest first
 *   balanceSheet: [{ cash, otherAssets, totalLiabilities, equity }, ...],
 *   cashFlow: [{ operatingCash, investingCash, financingCash }, ...]
 * }
 * returns: { projections: {...}, narrative: string, flags: [...] }
 */
function generateForecast(input) {
  const { periodType, periodsAhead, incomeStatement, balanceSheet, cashFlow } = input;

  if (!incomeStatement || incomeStatement.length < 3) {
    throw new Error('At least 3 historical periods of Income Statement data are required for a reliable forecast.');
  }
  if (!balanceSheet || balanceSheet.length < 3) {
    throw new Error('At least 3 historical periods of Balance Sheet data are required for a reliable forecast.');
  }
  if (!cashFlow || cashFlow.length < 3) {
    throw new Error('At least 3 historical periods of Cash Flow Statement data are required for a reliable forecast.');
  }

  // --- INCOME STATEMENT PROJECTIONS ---
  const revenues = incomeStatement.map(p => p.revenue);
  const cogsValues = incomeStatement.map(p => p.cogs);
  const opexValues = incomeStatement.map(p => p.opex);

  const projectedRevenue = projectLineItem(revenues, periodsAhead);
  const projectedCogs = projectLineItem(cogsValues, periodsAhead);
  const projectedOpex = projectLineItem(opexValues, periodsAhead);

  const projectedGrossProfit = projectedRevenue.map((r, i) => r - projectedCogs[i]);
  const projectedNetProfit = projectedGrossProfit.map((gp, i) => gp - projectedOpex[i]);

  const revenueGrowthRate = averageGrowthRate(revenues);
  const expenseGrowthRate = averageGrowthRate(opexValues.map((o, i) => o + cogsValues[i]));

  // --- BALANCE SHEET PROJECTIONS ---
  const cashValues = balanceSheet.map(p => p.cash);
  const otherAssetsValues = balanceSheet.map(p => p.otherAssets);
  const liabilitiesValues = balanceSheet.map(p => p.totalLiabilities);
  const equityValues = balanceSheet.map(p => p.equity);

  const projectedOtherAssets = projectLineItem(otherAssetsValues, periodsAhead);
  const projectedLiabilities = projectLineItem(liabilitiesValues, periodsAhead);

  const liabilityGrowthRate = averageGrowthRate(liabilitiesValues);
  const assetGrowthRate = averageGrowthRate(otherAssetsValues.map((a, i) => a + cashValues[i]));

  // --- CASH FLOW PROJECTIONS ---
  const operatingCashValues = cashFlow.map(p => p.operatingCash);
  const investingCashValues = cashFlow.map(p => p.investingCash);
  const financingCashValues = cashFlow.map(p => p.financingCash);

  const projectedOperatingCash = projectLineItem(operatingCashValues, periodsAhead);
  const projectedInvestingCash = projectLineItem(investingCashValues, periodsAhead);
  const projectedFinancingCash = projectLineItem(financingCashValues, periodsAhead);

  // Project actual cash balance forward: start from last known cash, add each period's net cash flow
  const lastCashBalance = cashValues[cashValues.length - 1];
  const projectedCashBalance = [];
  let runningCash = lastCashBalance;
  for (let i = 0; i < periodsAhead; i++) {
    const netCashChange = projectedOperatingCash[i] + projectedInvestingCash[i] + projectedFinancingCash[i];
    runningCash = Math.round((runningCash + netCashChange) * 100) / 100;
    projectedCashBalance.push(runningCash);
  }

  const cashGrowthRate = averageGrowthRate(cashValues);
  const firstNegativeCashIndex = projectedCashBalance.findIndex(c => c < 0);

  // --- CROSS-STATEMENT FLAGS (the synthesis logic) ---
  const flags = [];

  const profitGrowing = projectedNetProfit[projectedNetProfit.length - 1] > incomeStatement[incomeStatement.length - 1].revenue - incomeStatement[incomeStatement.length - 1].cogs - incomeStatement[incomeStatement.length - 1].opex;
  const cashDeclining = cashGrowthRate < -0.01;

  if (profitGrowing && cashDeclining) {
    flags.push({
      type: 'profit_cash_divergence',
      severity: 'warning',
      message: 'Your income statement shows growing profit, but your actual cash balance has been declining. This usually means customers are paying slower than your bills are coming due, or money is tied up in inventory/receivables.'
    });
  }

  if (liabilityGrowthRate > assetGrowthRate + 0.05) {
    flags.push({
      type: 'debt_outpacing_assets',
      severity: 'warning',
      message: 'Your liabilities have been growing faster than your assets. If this trend continues, your business is becoming less financially stable over time, even if revenue looks fine.'
    });
  }

  if (firstNegativeCashIndex !== -1) {
    flags.push({
      type: 'cash_shortfall_projected',
      severity: 'critical',
      message: `Based on current trends, your cash balance is projected to go negative in period ${firstNegativeCashIndex + 1} of your forecast. This is the most urgent issue to address.`
    });
  }

  if (revenueGrowthRate > 0 && expenseGrowthRate > revenueGrowthRate * 1.5) {
    flags.push({
      type: 'expenses_outpacing_revenue',
      severity: 'warning',
      message: 'Your expenses have been growing significantly faster than your revenue. Even with sales increasing, this pattern erodes profitability over time.'
    });
  }

  if (flags.length === 0) {
    flags.push({
      type: 'stable_trajectory',
      severity: 'good',
      message: 'Your three statements are telling a consistent, healthy story: revenue, cash, and financial position are moving in the same positive direction.'
    });
  }

  // --- NARRATIVE GENERATION ---
  const narrative = buildNarrative({
    periodType, periodsAhead,
    revenueGrowthRate, expenseGrowthRate, cashGrowthRate, liabilityGrowthRate, assetGrowthRate,
    projectedRevenue, projectedNetProfit, projectedCashBalance,
    flags, firstNegativeCashIndex
  });

  return {
    projections: {
      incomeStatement: {
        revenue: projectedRevenue,
        cogs: projectedCogs,
        opex: projectedOpex,
        grossProfit: projectedGrossProfit,
        netProfit: projectedNetProfit,
      },
      balanceSheet: {
        otherAssets: projectedOtherAssets,
        totalLiabilities: projectedLiabilities,
        cash: projectedCashBalance,
      },
      cashFlow: {
        operatingCash: projectedOperatingCash,
        investingCash: projectedInvestingCash,
        financingCash: projectedFinancingCash,
        endingCashBalance: projectedCashBalance,
      },
    },
    trends: {
      revenueGrowthRate,
      expenseGrowthRate,
      cashGrowthRate,
      liabilityGrowthRate,
      assetGrowthRate,
    },
    flags,
    narrative,
  };
}

function formatMoney(n) {
  const rounded = Math.round(n);
  return rounded < 0 ? `-$${Math.abs(rounded).toLocaleString()}` : `$${rounded.toLocaleString()}`;
}

function pct(rate) {
  return (rate * 100).toFixed(1) + '%';
}

function buildNarrative(data) {
  const {
    periodType, periodsAhead, revenueGrowthRate, expenseGrowthRate, cashGrowthRate,
    projectedRevenue, projectedNetProfit, projectedCashBalance, flags, firstNegativeCashIndex
  } = data;

  const unit = periodType === 'monthly' ? 'month' : 'quarter';
  const finalRevenue = projectedRevenue[projectedRevenue.length - 1];
  const finalProfit = projectedNetProfit[projectedNetProfit.length - 1];
  const finalCash = projectedCashBalance[projectedCashBalance.length - 1];

  let opening;
  if (revenueGrowthRate > 0.02) {
    opening = `Your business has been growing — revenue has increased an average of ${pct(revenueGrowthRate)} per ${unit} over your historical data.`;
  } else if (revenueGrowthRate < -0.02) {
    opening = `Your revenue has been declining — down an average of ${pct(Math.abs(revenueGrowthRate))} per ${unit} over your historical data.`;
  } else {
    opening = `Your revenue has been relatively flat over your historical data, changing by less than 2% per ${unit} on average.`;
  }

  let projectionSentence = `If this trend continues, in ${periodsAhead} ${unit}${periodsAhead > 1 ? 's' : ''} your revenue is projected to reach roughly ${formatMoney(finalRevenue)}, with a projected net profit of ${formatMoney(finalProfit)} for that period.`;

  let cashSentence;
  if (firstNegativeCashIndex !== -1) {
    cashSentence = `However, your cash balance is the real story here: based on current patterns, you're projected to run out of cash in ${unit} ${firstNegativeCashIndex + 1} of this forecast. This needs attention now, while there's still time to act — not later, once it becomes an emergency.`;
  } else if (cashGrowthRate > 0.02) {
    cashSentence = `Your cash position has been strengthening, and is projected to reach approximately ${formatMoney(finalCash)} by the end of this forecast period — a healthy trajectory.`;
  } else if (cashGrowthRate < -0.02) {
    cashSentence = `Your cash position has been weakening. Even though it isn't projected to go negative within this forecast window, the downward trend is worth addressing before it accelerates.`;
  } else {
    cashSentence = `Your cash position has been holding roughly steady, projected at approximately ${formatMoney(finalCash)} by the end of this forecast period.`;
  }

  const criticalFlags = flags.filter(f => f.severity === 'critical');
  const warningFlags = flags.filter(f => f.severity === 'warning');

  let flagSentence = '';
  if (criticalFlags.length > 0) {
    flagSentence = ` The most urgent thing to know: ${criticalFlags[0].message}`;
  } else if (warningFlags.length > 0) {
    flagSentence = ` Worth watching closely: ${warningFlags[0].message}`;
  } else {
    flagSentence = ` ${flags[0].message}`;
  }

  return `${opening} ${projectionSentence} ${cashSentence}${flagSentence}`;
}

const ForecastEngine = { generateForecast, linearRegression, projectLineItem, averageGrowthRate };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ForecastEngine;
}
if (typeof window !== 'undefined') {
  window.ForecastEngine = ForecastEngine;
}
