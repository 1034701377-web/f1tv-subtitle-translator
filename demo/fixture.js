const sentences = [
  'The gap is now 1.8 seconds.',
  'Box, box. We are switching to the hard tyres.',
  'Norris is closing in on the car ahead.',
  'The safety car has been deployed.',
  'Keep the tyres warm and stay within the delta.',
  'Hamilton sets the fastest lap with a 1:32.456.',
  'There are 12 laps remaining.',
  'Leclerc is defending into Turn 1.',
  'Rain is expected in about five minutes.',
  'Piastri has a five-second time penalty.',
  'DRS will be enabled on the next lap.',
  'What a move around the outside!'
];
export const fixture = sentences.map((text, i) => ({ id: `demo-${i + 1}`, start: 5 + i * 7, end: 10 + i * 7, text }));

export const translations = {
  "The gap is now 1.8 seconds.": "目前差距是 1.8 秒。",
  "Box, box. We are switching to the hard tyres.": "进站，进站。我们换上硬胎。",
  "Norris is closing in on the car ahead.": "诺里斯正在逼近前车。",
  "The safety car has been deployed.": "安全车已出动。",
  "Keep the tyres warm and stay within the delta.": "保持轮胎温度，遵守规定时间差。",
  "Hamilton sets the fastest lap with a 1:32.456.": "汉密尔顿以 1:32.456 刷新最快圈速。",
  "There are 12 laps remaining.": "比赛还剩 12 圈。",
  "Leclerc is defending into Turn 1.": "勒克莱尔在 1 号弯前防守。",
  "Rain is expected in about five minutes.": "预计约五分钟后下雨。",
  "Piastri has a five-second time penalty.": "皮亚斯特里被罚时五秒。",
  "DRS will be enabled on the next lap.": "下一圈将允许使用 DRS。",
  "What a move around the outside!": "一次漂亮的外线超车！"
};
