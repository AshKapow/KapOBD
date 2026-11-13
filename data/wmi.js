// World Manufacturer Identifiers: the first three characters of a VIN.
// Common makes only; two-character keys are fallbacks for a whole range.
export const WMI = {
  // France
  VF1: 'Renault', VF2: 'Renault', VF6: 'Renault Trucks', VF3: 'Peugeot', VF7: 'Citroën', VR1: 'DS Automobiles', VR3: 'Peugeot', VR7: 'Citroën', VNK: 'Toyota (France)',
  // Spain
  VSS: 'SEAT', VS6: 'Ford (Spain)', VSK: 'Nissan (Spain)', VWV: 'Volkswagen (Spain)', VSX: 'Opel (Spain)',
  // Germany
  WVW: 'Volkswagen', WV1: 'Volkswagen Commercial', WV2: 'Volkswagen Commercial', WAU: 'Audi', WUA: 'Audi Sport', WBA: 'BMW', WBS: 'BMW M', WBY: 'BMW i', WMW: 'MINI', WDB: 'Mercedes-Benz', WDD: 'Mercedes-Benz', W1K: 'Mercedes-Benz', W1N: 'Mercedes-Benz', WDC: 'Mercedes-Benz', WMX: 'Mercedes-AMG', WME: 'smart', WP0: 'Porsche', WP1: 'Porsche', WF0: 'Ford (Germany)', W0L: 'Opel / Vauxhall', W0V: 'Opel / Vauxhall',
  // United Kingdom
  SAJ: 'Jaguar', SAD: 'Jaguar', SAL: 'Land Rover', SAR: 'Rover', SCC: 'Lotus', SCF: 'Aston Martin', SCA: 'Rolls-Royce', SCB: 'Bentley', SHH: 'Honda (UK)', SHS: 'Honda (UK)', SJN: 'Nissan (UK)', SB1: 'Toyota (UK)', SFD: 'Alexander Dennis', SBM: 'McLaren',
  // Italy
  ZFA: 'Fiat', ZFB: 'Fiat', ZFC: 'Fiat', ZAR: 'Alfa Romeo', ZFF: 'Ferrari', ZHW: 'Lamborghini', ZAM: 'Maserati', ZLA: 'Lancia', ZCF: 'Iveco', ZDM: 'Ducati', ZAP: 'Piaggio',
  // Rest of Europe
  TMB: 'Škoda', TMA: 'Hyundai (Czech)', TRU: 'Audi (Hungary)', TSM: 'Suzuki (Hungary)', U5Y: 'Kia (Slovakia)', UU1: 'Dacia', YV1: 'Volvo', YV4: 'Volvo', YS3: 'Saab', YS2: 'Scania', XLR: 'DAF', NMT: 'Toyota (Turkey)', NM0: 'Ford (Turkey)',
  // Japan
  JMZ: 'Mazda', JM1: 'Mazda', JM3: 'Mazda', JN1: 'Nissan', JN3: 'Nissan', JN8: 'Nissan', JTD: 'Toyota', JTE: 'Toyota', JTH: 'Lexus', JTJ: 'Lexus', JTN: 'Toyota', JT1: 'Toyota', JT2: 'Toyota', JT3: 'Toyota', JT4: 'Toyota', JTM: 'Toyota', JHM: 'Honda', JHL: 'Honda', JF1: 'Subaru', JF2: 'Subaru', JSA: 'Suzuki', JS3: 'Suzuki', JMB: 'Mitsubishi', JMY: 'Mitsubishi', JA3: 'Mitsubishi', JA4: 'Mitsubishi', JAL: 'Isuzu', JDA: 'Daihatsu', JYA: 'Yamaha', JKA: 'Kawasaki',
  // Korea
  KMH: 'Hyundai', KM8: 'Hyundai', KNA: 'Kia', KNB: 'Kia', KNC: 'Kia', KND: 'Kia', KNM: 'Renault Samsung', KPT: 'SsangYong / KGM', KL: 'GM Korea / Daewoo',
  // China
  LRW: 'Tesla (China)', LSV: 'Volkswagen (China)', LFV: 'Volkswagen (China)', LVS: 'Ford (China)', LJ1: 'JAC', LGX: 'BYD', LC0: 'BYD', LB3: 'Geely', LVV: 'Chery', LSJ: 'MG (SAIC)', LPS: 'Polestar', LVG: 'Toyota (China)', LHG: 'Honda (China)',
  // North America
  '1G': 'General Motors', '1FA': 'Ford', '1FT': 'Ford', '1FM': 'Ford', '1C': 'Chrysler / Stellantis', '1HG': 'Honda (USA)', '1N4': 'Nissan (USA)', '1VW': 'Volkswagen (USA)', '2T': 'Toyota (Canada)', '2HG': 'Honda (Canada)', '3VW': 'Volkswagen (Mexico)', '3N1': 'Nissan (Mexico)', '4T': 'Toyota (USA)', '5YJ': 'Tesla', '5UX': 'BMW (USA)', '5N1': 'Nissan (USA)', '5NP': 'Hyundai (USA)',
  // Elsewhere
  MAL: 'Hyundai (India)', MA3: 'Suzuki (India)', MAJ: 'Ford (India)', MR0: 'Toyota (Thailand)', MNT: 'Nissan (Thailand)', '6T1': 'Toyota (Australia)', '9BW': 'Volkswagen (Brazil)', '93H': 'Honda (Brazil)',
};
