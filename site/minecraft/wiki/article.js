// Article HTML is complete without scripting; only enhance sidebar/search controls.
const toggle=document.querySelector('.wiki-topics-toggle');
const topics=document.querySelector('#wiki-topics');
toggle.addEventListener('click',()=>{
  const open=toggle.getAttribute('aria-expanded')!=='true';
  toggle.setAttribute('aria-expanded',String(open));topics.classList.toggle('is-open',open);
});
document.querySelector('.wiki-search').addEventListener('submit',event=>{
  event.preventDefault();
  location.href='../#/search?q='+encodeURIComponent(document.querySelector('#wiki-search').value.trim());
});
for(const item of topics.querySelectorAll('a')){
  if(new URL(item.href).pathname===location.pathname)item.setAttribute('aria-current','page');
}
