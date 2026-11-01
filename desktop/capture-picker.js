document.getElementById('cancel').onclick=()=>window.capturePicker.choose(null);
window.capturePicker.list().then(sources=>{
 const container=document.getElementById('sources');
 if(!sources.length)container.textContent='Нет доступных экранов или окон.';
 for(const source of sources){const button=document.createElement('button'),image=document.createElement('img'),label=document.createElement('p');image.src=source.image;image.alt='';label.textContent=source.name;button.append(image,label);button.onclick=()=>window.capturePicker.choose(source.id);container.append(button);}
});
