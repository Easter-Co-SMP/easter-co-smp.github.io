// One bundled content source for the website and launcher. These are demo pages,
// not authoritative gameplay instructions. Add articles here without changing the UI.
export const groups = ['Start here', 'Explore the Isles', 'Make your way'];
export const pages = [
  {
    id: 'getting-started', title: 'Getting started', group: 'Start here', icon: 'compass',
    summary: 'A first stop for new arrivals: find your bearings and plan what to explore.',
    sections: [
      { id: 'first-steps', title: 'Your first steps', text: 'This is a sample introduction for new players. The finished guide will explain how to join, settle in and get ready for a first adventure.', list: ['Arrive in the Isles.', 'Find a place to begin.', 'Choose your next adventure.'] },
      { id: 'find-your-way', title: 'Find your way', text: 'The world map is a useful companion to the wiki. This section will eventually introduce the starting area and explain how to read the chart.', map: true },
      { id: 'what-next', title: 'What next?', text: 'Follow a related article to try the wiki navigation. Ships, cooking and expeditions each have a sample page of their own.' },
    ],
    related: ['ships-and-sailing', 'cooking-and-crafting'],
  },
  {
    id: 'ships-and-sailing', title: 'Ships & sailing', group: 'Explore the Isles', icon: 'ship',
    summary: 'A place for ship guides, life at sea and setting out with a crew.',
    sections: [
      { id: 'before-you-sail', title: 'Before you sail', text: 'This sample page shows how a sailing guide could be organised. Ship controls, equipment and preparation will be documented after the content is verified.', list: ['Prepare the ship.', 'Gather your crew.', 'Pick a destination on the chart.'] },
      { id: 'aboard-your-ship', title: 'Aboard your ship', text: 'Space for an illustrated explanation of piloting, storage and looking after a vessel. These are example topics, not current instructions or requirements.' },
      { id: 'chart-a-course', title: 'Chart a course', text: 'Future guides can link to places and regions as the wiki grows. For now, open the shared world map or try the Isles article.', map: true },
    ],
    related: ['the-easter-isles', 'law-and-bounties'],
  },
  {
    id: 'the-easter-isles', title: 'The Easter Isles', group: 'Explore the Isles', icon: 'map',
    summary: 'An index for places, regions and discoveries across the world.',
    sections: [
      { id: 'a-world-to-explore', title: 'A world to explore', text: 'A sample landing page for the world itself. The finished article can introduce the Isles and lead into individual location guides.' },
      { id: 'places-and-regions', title: 'Places & regions', text: 'This is where descriptions of named regions and points of interest will belong. No new locations or region rules are being defined by this demo.', list: ['Starting areas and settlements.', 'Coastlines and sailing routes.', 'Landmarks worth a visit.'] },
      { id: 'the-world-chart', title: 'The world chart', text: 'Use the map for the published world snapshot. Wiki entries can later provide the context behind the places shown there.', map: true },
    ],
    related: ['getting-started', 'ships-and-sailing'],
  },
  {
    id: 'law-and-bounties', title: 'Law & bounties', group: 'Make your way', icon: 'scales',
    summary: 'A home for guides to Navy territory, piracy and bounty hunting.',
    sections: [
      { id: 'law-in-the-isles', title: 'Law in the Isles', text: 'This is a demonstration article, not a statement of active game rules. The real guide will explain where the law applies and how players can recognise those areas.' },
      { id: 'choose-a-path', title: 'Choose a path', text: 'A future section for the Navy Conscript, Pirate Raider and Bounty Hunter roles. Their mechanics and differences will be documented here once verified.' },
      { id: 'bounties-and-consequences', title: 'Bounties & consequences', text: 'Reserved for clear examples of crimes, bounties and their consequences. The demo deliberately specifies no prices, penalties or enforcement rules.' },
    ],
    related: ['the-easter-isles', 'ships-and-sailing'],
  },
  {
    id: 'cooking-and-crafting', title: 'Cooking & crafting', group: 'Make your way', icon: 'bowl',
    summary: 'A future recipe book for gathering, cooking, baking and brewing.',
    sections: [
      { id: 'from-supplies-to-supper', title: 'From supplies to supper', text: 'A sample article for the quieter side of life in the Isles. The finished guide will bring together ingredients, useful supplies and ways to contribute.' },
      { id: 'the-recipe-book', title: 'The recipe book', text: 'Recipe pages will eventually show verified ingredients and steps. This demo supplies an outline rather than inventing recipes.', list: ['Gathering and ingredients.', 'Cooking and baking.', 'Brewing and useful preparations.'] },
      { id: 'prepare-for-the-journey', title: 'Prepare for the journey', text: 'Future links can connect recipes with sailing or expedition preparations, so a player can move naturally between related guides.' },
    ],
    related: ['getting-started', 'raids-and-expeditions'],
  },
  {
    id: 'raids-and-expeditions', title: 'Raids & expeditions', group: 'Make your way', icon: 'flag',
    summary: 'A place for encounter guides, preparation and adventures with a group.',
    sections: [
      { id: 'gather-your-party', title: 'Gather your party', text: 'This demo page is a template for future group adventures. It shows where an introduction, preparation checklist and encounter sections could live.' },
      { id: 'prepare-together', title: 'Prepare together', text: 'The real guide will document the supplies and coordination each encounter needs. These sample headings introduce no equipment or group-size requirements.', list: ['Choose an expedition.', 'Plan with your group.', 'Prepare together.'] },
      { id: 'the-encounter-guide', title: 'The encounter guide', text: 'A space for verified mechanics, diagrams and rewards. Detailed strategies and weekly schedules are outside the scope of these placeholder pages.' },
    ],
    related: ['cooking-and-crafting', 'getting-started'],
  },
];
export function searchPages(query) {
  const normalized = query.trim().toLocaleLowerCase();
  const terms = normalized.split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return pages.filter(page => {
    const text = [page.title, page.group, page.summary, ...page.sections.flatMap(section =>
      [section.title, section.text, ...(section.list || [])])].join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => Number(b.title.toLocaleLowerCase().includes(normalized))
    - Number(a.title.toLocaleLowerCase().includes(normalized)));
}
