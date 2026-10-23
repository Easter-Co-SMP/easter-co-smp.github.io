// Display copy only. A payment service must decide all amounts charged.
export const CATALOGUE = Object.freeze([
  { key: 'sterling-10', name: '10 Sterling', price: '$1.49', category: 'In-game currency', description: '10 Sterling for use in Easter Co. SMP.', mark: '10' },
  { key: 'sterling-100', name: '100 Sterling', price: '$6.95', category: 'In-game currency', description: '100 Sterling for use in Easter Co. SMP.', mark: '100' },
  { key: 'sterling-1000', name: '1000 Sterling', price: '$29.99', category: 'In-game currency', description: '1000 Sterling for use in Easter Co. SMP.', mark: '1000' },
  { key: 'donation-5', name: 'Keep the lights on (a donation)', price: '$5.00', category: 'Donation', description: 'A $5.00 donation to support Easter Co. SMP.', mark: '✦' },
  { key: 'penny', name: 'Penny for the poor', price: '$0.01', category: 'Community', description: 'A one-cent contribution.', mark: '1¢' },
].map(product => Object.freeze(product)));
