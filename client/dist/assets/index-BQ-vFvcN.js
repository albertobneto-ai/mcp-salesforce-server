<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <title>Ever i9 — Spec AI Platform</title>
    <script type="module" crossorigin src="/assets/index-BQ-vFvcN.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-BOQReWeI.css">
  </head>
  <body>
    <div id="root"></div>
  <script>
(function(){
  function gr(){try{return JSON.parse(localStorage.getItem('everi9_user')||'{}').role||'';}catch(e){return'';}}

  /* === Data Cloud Overlay === */
  var ov=document.createElement('div');ov.id='dc-overlay';ov.style.cssText='position:fixed;inset:0;z-index:1050;display:none;';
  var ifr=document.createElement('iframe');ifr.style.cssText='width:100%;height:100%;border:none;';
  ov.appendChild(ifr);document.body.appendChild(ov);

  /* === CRM Algar Overlay === */
  var ov2=document.createElement('div');ov2.id='crm-overlay';ov2.style.cssText='position:fixed;inset:0;z-index:1050;display:none;';
  var ifr2=document.createElement('iframe');ifr2.style.cssText='width:100%;height:100%;border:none;';
  ov2.appendChild(ifr2);document.body.appendChild(ov2);

  /* === Squad Agentes SF Overlay === */
  var ov3=document.createElement('div');ov3.id='squad-overlay';ov3.style.cssText='position:fixed;inset:0;z-index:1050;display:none;';
  var ifr3=document.createElement('iframe');ifr3.style.cssText='width:100%;height:100%;border:none;';
  ov3.appendChild(ifr3);document.body.appendChild(ov3);

  /* === Lab Overlay === */
  var ov4=document.createElement('div');ov4.id='lab-overlay';ov4.style.cssText='position:fixed;inset:0;z-index:1050;display:none;';
  var ifr4=document.createElement('iframe');ifr4.style.cssText='width:100%;height:100%;border:none;';
  ov4.appendChild(ifr4);document.body.appendChild(ov4);
  window.__closeLabOverlay=function(){ov4.style.display='none';};

  /* === Refinamentos Overlay === */
  var ov5=document.createElement('div');ov5.id='ref-overlay';ov5.style.cssText='position:fixed;inset:0;z-index:1050;display:none;';
  var ifr5=document.createElement('iframe');ifr5.style.cssText='width:100%;height:100%;border:none;';
  ov5.appendChild(ifr5);document.body.appendChild(ov5);

  /* === HF Studio Overlay === */
  var ov6=document.createElement('div');ov6.id='hf-overlay';ov6.style.cssText='position:fixed;inset:0;z-index:1050;display:none;';
  var ifr6=document.createElement('iframe');ifr6.style.cssText='width:100%;height:100%;border:none;';
  ov6.appendChild(ifr6);document.body.appendChild(ov6);
  window.__openHFStudio=function(){ifr6.src='/hf-studio.html';ov6.style.display='block';};

  /* === Message handler for all overlays === */
  window.addEventListener('message',function(e){
    if(e.data==='dc-closed')ov.style.display='none';
    if(e.data==='crm-closed')ov2.style.display='none';
    if(e.data==='squad-closed')ov3.style.display='none';
    if(e.data==='lab-closed')ov4.style.display='none';
    if(e.data==='ref-closed')ov5.style.display='none';
    if(e.data==='hf-closed')ov6.style.display='none';
  });

  /* === Role-based redirects === */
  var roleRedirected=false;
  var roleCheck=setInterval(function(){
    if(roleRedirected)return;
    var role=gr();
    var hasToken=!!localStorage.getItem('everi9_token');
    if(!role||!hasToken)return;
    var squadRoles=['architect','desenvolvedor','developer'];
    if(squadRoles.indexOf(role)>=0){
      roleRedirected=true;
      clearInterval(roleCheck);
      window.location.href='/squad.html';
      return;
    }
  },1000);

  /* === Hide DC/GP from header + robot logo === */
  setInterval(function(){
    var bs=document.querySelectorAll('button');
    for(var i=0;i<bs.length;i++){
      var t=bs[i].textContent.trim();
      if(t==='\u2601\uFE0F DC'||t==='\u2601 DC'){bs[i].style.display='none';}
      if(t==='GP'&&bs[i].title&&bs[i].title.indexOf('Painel')>=0){bs[i].style.display='none';}
    }
    var imgs=document.querySelectorAll('img[alt="Ever i9"]');
    for(var j=0;j<imgs.length;j++){imgs[j].style.display='none';}
  },500);

  /* === Inject app drawer under Aplicacoes sidebar item === */
  setInterval(function(){
    var role=gr();if(!role)return;
    if(document.getElementById('apps-drawer'))return;
    var isAdmin=role==='admin'||role==='architect';

    var all=document.querySelectorAll('*');
    var target=null;
    for(var i=0;i<all.length;i++){
      var el=all[i];
      if(el.childElementCount>3)continue;
      var txt=(el.textContent||'').trim();
      if(txt==='\u25EB Aplica\u00E7\u00F5es'||txt==='\u25EBAplica\u00E7\u00F5es'){
        target=el;break;
      }
    }
    if(!target)return;

    var drawer=document.createElement('div');drawer.id='apps-drawer';
    drawer.style.cssText='max-height:0;overflow:hidden;transition:max-height .25s ease;margin:0 8px;';

    var inner=document.createElement('div');
    inner.style.cssText='display:flex;flex-direction:column;gap:2px;padding:4px 0;';

    function mkApp(id,label,color,fn){
      var btn=document.createElement('div');btn.id=id;
      btn.style.cssText='padding:8px 14px 8px 32px;border-radius:8px;font-size:12px;font-weight:500;color:#94a3b8;cursor:pointer;font-family:Outfit,sans-serif;transition:all .12s;';
      btn.textContent=label;
      btn.onmouseenter=function(){this.style.background='#2a2a3e';this.style.color='#e2e8f0'};
      btn.onmouseleave=function(){this.style.background='transparent';this.style.color='#94a3b8'};
      btn.onclick=function(ev){ev.stopPropagation();ev.preventDefault();fn();};
      return btn;
    }

    var isFuncional=role==='funcional';

    /* HF Studio — visível para TODOS os perfis */
    inner.appendChild(mkApp('app-hf-studio','HF Studio','#6c44a0',function(){
      ov6.style.display='block';ifr6.src='/hf-studio.html';
    }));

    if(!isFuncional){
    /* GP */
    inner.appendChild(mkApp('app-gp','Gest\u00E3o de Projetos','#94a3b8',function(){
      var bs=document.querySelectorAll('button');
      for(var j=0;j<bs.length;j++){if(bs[j].title&&bs[j].title.indexOf('Painel GP')>=0){bs[j].click();break;}}
    }));

    /* Squad */
    inner.appendChild(mkApp('app-squad','Squad Agentes','#a78bfa',function(){
      ov3.style.display='block';ifr3.src='/squad.html';
    }));

    /* Refinamentos */
    inner.appendChild(mkApp('app-ref','Refinamentos','#7c6df0',function(){
      ov5.style.display='block';ifr5.src='/refinamentos.html';
    }));

    if(isAdmin){
      inner.appendChild(mkApp('app-dc','Data Cloud','#06b6d4',function(){
        ov.style.display='block';ifr.src='/datacloud.html';
      }));
      inner.appendChild(mkApp('app-crm','CRM Algar','#10b981',function(){
        ov2.style.display='block';ifr2.src='/crm-algar.html';
      }));
    }

    /* Laboratorio */
    inner.appendChild(mkApp('app-lab','Laborat\u00F3rio','#f59e0b',function(){
      ov4.style.display='block';ifr4.src='/lab.html';
    }));

    /* DevTools AI */
    inner.appendChild(mkApp('app-devtools','DevTools AI','#7c3aed',function(){
      ov4.style.display='block';ifr4.src='/devtools.html';
    }));

    /* Partner Community */
    inner.appendChild(mkApp('app-partner','Partner Community','#430098',function(){
      ov4.style.display='block';ifr4.src='/partner-users.html';
    }));

    /* i9 Connect */
    inner.appendChild(mkApp('app-connect','i9 Connect','#2ecc71',function(){
      window.open('https://i9-connect-810d67dd8ef9.herokuapp.com/','_blank');
    }));

    /* External APIs */
    inner.appendChild(mkApp('app-extapi','External APIs','#9333ea',function(){
      ov4.style.display='block';ifr4.src='https://ever-i9-api-mgmt-9ffe0302261d.herokuapp.com/api/external/';
    }));

    /* API Gateway */
    inner.appendChild(mkApp('app-gateway','API Management','#6d28d9',function(){
      ov4.style.display='block';ifr4.src='https://ever-i9-api-mgmt-9ffe0302261d.herokuapp.com/';
    }));
    /* SF Agent */
    inner.appendChild(mkApp('app-sfagent','SF Agent','#111',function(){
      ov4.style.display='block';ifr4.src='https://ever-i9-sf-agent-f185b516bfcd.herokuapp.com/';
    }));
    /* Spec Generator */
    inner.appendChild(mkApp('app-spec-gen','Spec Generator','#0ea5e9',function(){
      ov4.style.display='block';ifr4.src='/spec-generator.html';
    }));

    } /* fim !isFuncional */

    drawer.appendChild(inner);

    if(target.nextSibling){
      target.parentNode.insertBefore(drawer,target.nextSibling);
    }else{
      target.parentNode.appendChild(drawer);
    }

    var expanded=false;
    target.addEventListener('click',function(ev){
      ev.stopImmediatePropagation();ev.preventDefault();ev.stopPropagation();
      expanded=!expanded;
      drawer.style.maxHeight=expanded?(inner.scrollHeight+12)+'px':'0';
    },true);

    /* === STUDIO SECTION === */
    var studioNav=document.createElement('div');
    studioNav.style.cssText='display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;border-radius:10px;font-family:Outfit,sans-serif;font-size:14px;font-weight:500;color:#64748b;transition:all .15s;margin:4px 8px 0 8px;';
    studioNav.innerHTML='\u25A3 Studio';
    studioNav.onmouseenter=function(){this.style.background='#2a2a3e';this.style.color='#e2e8f0'};
    studioNav.onmouseleave=function(){this.style.background='transparent';this.style.color='#64748b'};

    var sDraw=document.createElement('div');sDraw.id='studio-drawer';
    sDraw.style.cssText='max-height:0;overflow:hidden;transition:max-height .25s ease;margin:0 8px;';
    var sInner=document.createElement('div');
    sInner.style.cssText='display:flex;flex-direction:column;gap:2px;padding:4px 0;';

    function mkStd(id,lbl,clr,url){
      var b=document.createElement('div');b.id=id;
      b.style.cssText='padding:8px 14px 8px 32px;border-radius:8px;font-size:12px;font-weight:500;color:#94a3b8;cursor:pointer;font-family:Outfit,sans-serif;transition:all .12s;';
      b.textContent=lbl;
      b.onmouseenter=function(){this.style.background='#2a2a3e';this.style.color='#e2e8f0'};
      b.onmouseleave=function(){this.style.background='transparent';this.style.color='#94a3b8'};
      b.onclick=function(ev){ev.stopPropagation();ev.preventDefault();ov4.style.display='block';ifr4.src=url;};
      return b;
    }

    sInner.appendChild(mkStd('s-sales','Sales Cloud Studio','#3B82F6','https://ever-i9-sales-cloud-07d4df5f957b.herokuapp.com/'));
    sInner.appendChild(mkStd('s-revenue','Revenue Cloud Studio','#1a3150','https://ever-i9-revenue-cloud-b804dcab5bbe.herokuapp.com/'));
    sInner.appendChild(mkStd('s-integ','Integration Studio','#0A84FF','https://ever-i9-studio-4ef8dd93c531.herokuapp.com/'));
    sInner.appendChild(mkStd('s-catalog','Catalog Studio','#16a34a','/revenue-catalog.html'));
    sInner.appendChild(mkStd('s-brain','Brain Studio','#38bdf8','/brain-studio.html'));
    sDraw.appendChild(sInner);

    var sExp=false;
    studioNav.addEventListener('click',function(ev){
      ev.stopImmediatePropagation();ev.preventDefault();ev.stopPropagation();
      sExp=!sExp;
      sDraw.style.maxHeight=sExp?(sInner.scrollHeight+12)+'px':'0';
    },true);

    /* Insert Studio after Aplicações drawer */
    if(drawer.nextSibling){
      drawer.parentNode.insertBefore(studioNav,drawer.nextSibling);
      studioNav.parentNode.insertBefore(sDraw,studioNav.nextSibling);
    }else{
      drawer.parentNode.appendChild(studioNav);
      drawer.parentNode.appendChild(sDraw);
    }

  },800);

})();
</script>
  <script>
  (function(){
    var ROBOT_IMG='data:image/png;base64,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';
    function replaceAvatars(){
      document.querySelectorAll('div').forEach(function(el){
        if(el.textContent.trim()==='i9' && 
           el.children.length===0 &&
           el.style.borderRadius==='50%' &&
           el.style.background &&
           el.style.background.indexOf('#22c55e')>=0){
          el.textContent='';
          el.style.background='transparent';
          el.style.backgroundImage='url('+ROBOT_IMG+')';
          el.style.backgroundSize='cover';
          el.style.backgroundPosition='center';
        }
      });
    }
    var obs=new MutationObserver(replaceAvatars);
    obs.observe(document.body,{childList:true,subtree:true});
    setInterval(replaceAvatars,2000);
  })();
  </script>

</body>
</html>
