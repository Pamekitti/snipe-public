// The sim-vs-live drift statistic, in one place because it is an ALARM and alarms should
// not be re-derived per consumer.
//
// It reads the median, not the mean. It was the mean until 2026-08-26, when it fired at
// -3.93pp over 50 trades whose median gap was 0.00 and 38 of which matched the sim
// exactly. The entire -3.93 was one row: position 870, a 2.36x runner where live made
// +0.0165 ETH against the sim's +0.0058 -- reality BEAT the model by 215pp of one trade's
// spend. Per-trade gaps have tails that fat because a gap is divided by a single spend, so
// their mean is not a summary of anything. An alarm that fires on one good trade is an
// alarm you learn to scroll past.
//
// The mean is still reported alongside, because a genuine drift moves both and the pair
// says which kind of problem you have.
const LIMIT_PP = 1.5

function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function reconSummary(gaps) {
  const n = gaps.length
  const med = median(gaps)
  const mean = n ? gaps.reduce((a, g) => a + g, 0) / n : 0
  const sign = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}pp`
  return {
    n, median: med, mean,
    alarm: n > 0 && Math.abs(med) > LIMIT_PP,
    text: n ? `recon n=${n} gap=${sign(med)} mean=${sign(mean)}` : 'recon=–',
  }
}

module.exports = { reconSummary, median, LIMIT_PP }
