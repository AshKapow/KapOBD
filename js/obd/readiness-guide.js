// Plain-English hints for completing readiness monitors (generic guidance;
// the exact "drive cycle" differs between manufacturers).

export const GENERAL_ADVICE =
  'Most cars complete their self-checks within a few days of mixed driving: a start from cold, some town driving, and 15–20 minutes of steady faster driving. The exact conditions vary by manufacturer, and some checks only run once a day.';

const TIPS = {
  Misfire: 'Checked continuously while driving; usually completes on any short drive.',
  'Fuel system': 'Checked continuously while driving; usually completes on any short drive.',
  Components: 'Checked continuously while driving; usually completes on any short drive.',
  Catalyst: 'Once the engine is fully warm, drive at a steady 45–60 mph for about 10 minutes, for example on a dual carriageway.',
  'Heated catalyst': 'Usually runs just after a cold start: let the car sit overnight, then drive normally.',
  'Evaporative system': 'Often the slowest. It typically needs the car to sit for 8 hours or more, a fuel level between about a quarter and three-quarters full, then a cold start and normal driving.',
  'Secondary air': 'Runs in the first minute or two after a cold start.',
  'A/C refrigerant': 'Rarely used on modern cars.',
  'Oxygen sensor': 'Steady cruising once warm, followed by gently slowing down with your foot off the accelerator.',
  'Oxygen sensor heater': 'Runs during the first few minutes after a cold start.',
  'EGR / VVT': 'Steady cruising once warm, plus a few long slow-downs with your foot off the accelerator (for example coasting from 50–60 mph).',
  'NMHC catalyst': 'Sustained faster driving once fully warm, such as 20 minutes on a motorway or dual carriageway.',
  'NOx / SCR': 'Sustained faster driving once fully warm, such as 20 minutes on a motorway or dual carriageway.',
  'Boost pressure': 'Normal driving once warm, including some firm acceleration.',
  'Exhaust gas sensor': 'Steady cruising once the engine is fully warm.',
  'Particulate filter': 'A sustained run of 20 minutes or more at motorway or dual-carriageway speeds, which also lets the filter clean itself.',
};

export function readinessTip(monitorName) {
  return TIPS[monitorName] ?? null;
}
