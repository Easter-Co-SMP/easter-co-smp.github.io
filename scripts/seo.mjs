// One repeatable source for search metadata and crawlable wiki documents.
// node scripts/seo.mjs writes; --check refuses stale generated output in CI.
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {pages, groups} from '../site/minecraft/wiki/pages.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../site');
// The existing moved-map/wiki pages already identify this as the canonical host.
const origin='https://launcher.easter.company';
const check=process.argv.includes('--check');
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json=value=>JSON.stringify(value).replace(/</g,'\\u003c');
const image=origin+'/assets/crest.jpg';
const publisher={'@type':'Organization',name:'Easter LTD',url:'https://easter.company/'};
const publicPages=[
  ['','Easter Co. SMP — The Ultimate Minecraft Experience','A Minecraft survival server for beginners and veterans, with custom ships, Navy patrols, bounties, crafting and weekly raids. Download the Easter Company launcher.'],
  ['minecraft/map/','World Map — Easter Co. SMP','Explore the Easter Co. SMP Minecraft world: continents, regions, ships, Navy patrols and NPCs on a public chart. Player locations are never published.'],
  ['minecraft/wiki/','Wiki — Easter Co. SMP','The Easter Co. SMP field guide: getting started, health, death, ships, crews, law, banking, crafting, equipment and group expeditions.'],
  ['legal/privacy/','Privacy Policy — Easter Co. SMP','How Easter LTD handles personal data for the Easter Co. SMP website, Easter Company launcher, accounts and Minecraft server.'],
  ['legal/terms/','Terms of Service — Easter Co. SMP','The terms for using the Easter Co. SMP website, Easter Company launcher, accounts and Minecraft server, operated by Easter LTD.']
];
let failures=0;
function output(relative,content){
  const target=path.join(root,relative);
  if(existsSync(target)&&readFileSync(target,'utf8')===content)return;
  if(check){console.error('Stale SEO output: site/'+relative);failures++;return;}
  mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,content);
}
function metadata(html,route,title,description,article=false){
  html=html.replace(/<!-- SEO:START -->[\s\S]*?<!-- SEO:END -->\n?/g,'')
    .replace(/<title>[\s\S]*?<\/title>/g,'')
    .replace(/<meta\s+(?:name="(?:description|robots|twitter:[^"]+)"|property="og:[^"]+")[^>]*>/g,'')
    .replace(/<link\s+rel="canonical"[^>]*>/g,'');
  const url=origin+'/'+route;
  const schema={'@context':'https://schema.org','@graph':[
    {'@type':article?'Article':'WebPage','@id':url+'#page',url,name:title,headline:title,description,inLanguage:'en',publisher,
      isPartOf:{'@id':origin+'/#website'}},
    ...(route?[{'@type':'BreadcrumbList',itemListElement:[
      {'@type':'ListItem',position:1,name:'Easter Co. SMP',item:origin+'/'},
      ...(article?[{'@type':'ListItem',position:2,name:'Wiki',item:origin+'/minecraft/wiki/'}]:[]),
      {'@type':'ListItem',position:article?3:2,name:title.replace(' — Easter Co. SMP',''),item:url}
    ]}]:[{'@type':'WebSite','@id':origin+'/#website',url:origin+'/',name:'Easter Co. SMP',inLanguage:'en',publisher}])
  ]};
  const block=`<!-- SEO:START -->
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="${url}">
<meta property="og:type" content="${article?'article':'website'}">
<meta property="og:site_name" content="Easter Co. SMP">
<meta property="og:locale" content="en_GB">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${image}">
<meta property="og:image:alt" content="Easter Co. SMP phoenix and sailing ship crest">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${image}">
<meta name="twitter:image:alt" content="Easter Co. SMP phoenix and sailing ship crest">
<script type="application/ld+json">${json(schema)}</script>
<!-- SEO:END -->`;
  return html.replace('</head>',block+'\n</head>').replace(/^[ \t]+$/gm,'');
}
const wikiFile='minecraft/wiki/index.html';
let template=readFileSync(path.join(root,wikiFile),'utf8');
const topicNav=(prefix)=>`<a class="wiki-overview-link" href="${prefix||'./'}">Wiki overview</a>`+groups.map(group=>`<div class="wiki-topic-group"><p>${esc(group)}</p>${pages.filter(p=>p.group===group).map(p=>`<a href="${prefix}${p.id}/">${esc(p.title)}</a>`).join('')}</div>`).join('');
const overview=`<header class="wiki-page-header"><p class="eyebrow">Easter Co. SMP · Field guide</p><h1>Your guide to Easter Co. SMP.</h1><p class="wiki-intro">Find your bearings, chart a course, and make the world your own.</p></header><div class="wiki-section-heading"><h2>Browse the guide</h2><span>${pages.length} guides</span></div><div class="wiki-cards">${pages.map(p=>`<a class="wiki-card" href="${p.id}/"><div class="wiki-card-copy"><span class="wiki-card-group">${esc(p.group)}</span><h2>${esc(p.title)}</h2><p>${esc(p.summary)}</p></div></a>`).join('')}</div>`;
function main(html,content){return html.replace(/(<main id="wiki-content"[^>]*>)[\s\S]*?<\/main>/,`$1${content}</main>`);}
template=template.replace(/(<nav id="wiki-topics"[^>]*>)[\s\S]*?<\/nav>/,`$1${topicNav('')}</nav>`)
  .replace('Enable JavaScript to browse and search the wiki.','All guides are readable without JavaScript. Enable JavaScript to search the wiki.');
template=main(template,overview);
output(wikiFile,metadata(template,...publicPages[2]));

const byId=new Map(pages.map(p=>[p.id,p]));
const guideLinks=ids=>ids.map(id=>`<a href="../${id}/">${esc(byId.get(id).title)} →</a>`).join('');
for(const page of pages){
  const toc=`<nav aria-label="On this page">${page.sections.map(s=>`<a href="#${s.id}">${esc(s.title)}</a>`).join('')}</nav>`;
  const content=`<nav class="wiki-breadcrumb" aria-label="Breadcrumb"><a href="../">Wiki</a><span>/</span><span>${esc(page.group)}</span></nav><div class="wiki-reading"><article class="wiki-article"><header class="wiki-page-header"><p class="eyebrow">${esc(page.group)}</p><h1>${esc(page.title)}</h1><p class="wiki-intro">${esc(page.summary)}</p></header><details class="wiki-mobile-toc"><summary>On this page</summary>${toc}</details>${page.sections.map(s=>`<section class="wiki-article-section" id="${s.id}"><h2><a href="#${s.id}">${esc(s.title)}</a></h2><p>${esc(s.text)}</p>${s.list?`<ul>${s.list.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}${(s.paragraphs||[]).map(t=>`<p>${esc(t)}</p>`).join('')}${s.steps?`<ol class="wiki-steps">${s.steps.map(t=>`<li>${esc(t)}</li>`).join('')}</ol>`:''}${s.table?`<div class="wiki-table-wrap" tabindex="0" role="region" aria-label="${esc(s.table.caption)}"><table><caption>${esc(s.table.caption)}</caption><thead><tr>${s.table.headers.map(t=>`<th scope="col">${esc(t)}</th>`).join('')}</tr></thead><tbody>${s.table.rows.map(row=>`<tr>${row.map(t=>`<td>${esc(t)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:''}${s.note?`<aside class="wiki-note"><strong>${esc(s.note.title)}</strong><p>${esc(s.note.text)}</p></aside>`:''}${(s.paragraphsAfter||[]).map(t=>`<p>${esc(t)}</p>`).join('')}${s.links?.length?`<nav class="wiki-section-links" aria-label="${esc(s.title)} guides">${guideLinks(s.links)}</nav>`:''}${s.map?'<a class="wiki-inline-link" href="../../map/">Open the world map ↗</a>':''}</section>`).join('')}<section class="wiki-related"><h2>Keep exploring</h2>${guideLinks(page.related)}</section></article><aside class="wiki-outline"><p>On this page</p>${toc}</aside></div>`;
  let html=template.replace(/((?:href|src)=")\.\.\//g,'$1../../')
    .replaceAll('href="./"','href="../"')
    .replaceAll('href="#/"','href="../"')
    .replace('href="wiki.css"','href="../wiki.css"')
    .replace('src="wiki.js"','src="../article.js"');
  html=html.replace(/(<nav id="wiki-topics"[^>]*>)[\s\S]*?<\/nav>/,`$1${topicNav('../')}</nav>`);
  html=main(html,content).replace('All guides are readable without JavaScript. Enable JavaScript to search the wiki.','All guides are readable without JavaScript. Search is available from the wiki overview.');
  const route=`minecraft/wiki/${page.id}/`;
  output(route+'index.html',metadata(html,route,page.title+' — Easter Co. SMP',page.summary,true));
}
for(const [route,title,description] of publicPages.filter(([route])=>route!=='minecraft/wiki/')){
  const file=route+'index.html';output(file,metadata(readFileSync(path.join(root,file),'utf8'),route,title,description));
}
const urls=[...publicPages.map(([route])=>route),...pages.map(p=>'minecraft/wiki/'+p.id+'/')];
output('robots.txt',`User-agent: *\nAllow: /\n\n# Account, store, error and moved pages carry HTML noindex directives.\n# Keep them crawlable so search engines can read those directives.\nSitemap: ${origin}/sitemap.xml\n`);
output('sitemap.xml','<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+urls.map(route=>`  <url><loc>${origin}/${route}</loc></url>`).join('\n')+'\n</urlset>\n');
if(failures)process.exitCode=1;else console.log(`SEO output ${check?'verified':'updated'}: ${urls.length} canonical pages.`);
