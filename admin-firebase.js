(() => {
  'use strict';
  const listEl=document.getElementById('sessionList');
  const messagesEl=document.getElementById('messages');
  const titleEl=document.getElementById('chatTitle');
  const subEl=document.getElementById('chatSub');
  const form=document.getElementById('replyForm');
  const input=document.getElementById('replyInput');
  const button=document.getElementById('replyBtn');
  const navTarget=document.getElementById('navTarget');
  const navSend=document.getElementById('navSend');
  const accessToggle=document.getElementById('accessToggle');
  const navStatus=document.getElementById('navStatus');
  const baseTitle=document.title;
  let runtime=null;
  let sessions=[];
  let selectedUid='';
  let selectedSessionId='';
  let messages=[];
  let stopMessages=null;
  let stopSessions=null;
  let audioContext=null;
  let notificationsArmed=false;
  let permissionAsked=false;
  const lastUnread=new Map();
  let initialSnapshot=true;

  const short=value=>String(value||'').slice(-8)||'-';
  const fmt=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'-':d.toLocaleString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'})};
  const newId=()=>crypto?.randomUUID?.()||`admin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const selectedSession=()=>sessions.find(s=>s.firebaseUid===selectedUid)||null;

  async function armNotifications(){
    if(notificationsArmed)return;
    try{audioContext=new (window.AudioContext||window.webkitAudioContext)();await audioContext.resume();notificationsArmed=true;}catch{}
    if(!permissionAsked&&'Notification'in window&&Notification.permission==='default'){
      permissionAsked=true;try{await Notification.requestPermission()}catch{}
    }
  }

  function sound(){
    if(!notificationsArmed||!audioContext)return;
    try{
      const osc=audioContext.createOscillator();const gain=audioContext.createGain();
      osc.frequency.setValueAtTime(880,audioContext.currentTime);
      gain.gain.setValueAtTime(.0001,audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(.16,audioContext.currentTime+.015);
      gain.gain.exponentialRampToValueAtTime(.0001,audioContext.currentTime+.22);
      osc.connect(gain);gain.connect(audioContext.destination);osc.start();osc.stop(audioContext.currentTime+.24);
    }catch{}
  }

  function notifySession(s){
    sound();
    if(document.visibilityState==='visible'&&document.hasFocus())return;
    if('Notification'in window&&Notification.permission==='granted'){
      try{new Notification('Pesan Live Chat baru',{body:`Sesi ${short(s.id)}`,tag:`kb-firebase-chat:${s.firebaseUid}`,renotify:true,silent:true})}catch{}
    }
  }

  function updateTitle(){
    const total=sessions.reduce((n,s)=>n+Math.max(0,Number(s.adminUnread||0)),0);
    document.title=total>0?`(${total}) ${baseTitle}`:baseTitle;
  }

  function renderSessions(){
    listEl.innerHTML='';
    if(!sessions.length){listEl.innerHTML='<div class="empty">Belum ada sesi. Buka Live Chat pada <code>index.html</code> terlebih dahulu.</div>';updateTitle();return;}
    sessions.forEach(s=>{
      const btn=document.createElement('button');btn.type='button';btn.className=`session${selectedUid===s.firebaseUid?' active':''}`;
      const strong=document.createElement('strong');const name=document.createElement('span');name.textContent=`Sesi ${short(s.id)}`;strong.appendChild(name);
      if(Number(s.adminUnread||0)>0){const c=document.createElement('span');c.className='count';c.textContent=String(s.adminUnread);strong.appendChild(c)}
      const meta=document.createElement('small');const stale=Date.now()-new Date(s.lastAt).getTime()>45000;const offline=s.status==='offline'||stale;
      const dot=document.createElement('span');dot.className=`dot${offline?' offline':''}`;meta.appendChild(dot);
      meta.append(document.createTextNode(`${offline?'Offline':'Online'}${s.blocked?' • DIBLOKIR':''} • ${s.flowPage||'-'} • Tahap ${Number(s.flowStep||0)} • ${fmt(s.lastAt)}`));
      btn.append(strong,meta);btn.addEventListener('click',()=>selectSession(s.firebaseUid));listEl.appendChild(btn);
    });
    updateTitle();
  }

  function renderMessages(){
    messagesEl.innerHTML='';
    if(!selectedUid){messagesEl.innerHTML='<div class="empty">Pilih sesi chat di sebelah kiri.</div>';return;}
    if(!messages.length){messagesEl.innerHTML='<div class="empty">Belum ada pesan pada sesi ini.</div>';return;}
    for(const m of messages){
      const row=document.createElement('div');row.className=`row ${m.author==='admin'?'admin':'user'}`;
      const bubble=document.createElement('div');bubble.className='bubble';bubble.append(document.createTextNode(m.text));
      const time=document.createElement('span');time.className='time';time.textContent=`${m.author==='admin'?'Admin Simulasi':'Pengguna'} • ${fmt(m.at)}`;
      bubble.appendChild(time);row.appendChild(bubble);messagesEl.appendChild(row);
    }
    messagesEl.scrollTop=messagesEl.scrollHeight;
  }

  async function selectSession(uid){
    selectedUid=uid;const s=selectedSession();if(!s)return;
    selectedSessionId=s.id;titleEl.textContent=`Sesi ${short(s.id)}`;subEl.textContent=`${s.flowPage||'-'} • Tahap ${Number(s.flowStep||0)}${s.blocked?' • DIBLOKIR':''}`;
    input.disabled=false;button.disabled=!input.value.trim();navTarget.disabled=false;navSend.disabled=Boolean(s.blocked);accessToggle.disabled=false;
    accessToggle.textContent=s.blocked?'Buka Blokir':'Blokir User';accessToggle.classList.toggle('unblock',Boolean(s.blocked));
    if(s.flowPage&&[...navTarget.options].some(o=>o.value===s.flowPage))navTarget.value=s.flowPage;
    navStatus.textContent='';messages=[];renderSessions();renderMessages();
    if(stopMessages){try{stopMessages()}catch{}stopMessages=null;}
    stopMessages=await runtime.listenAdminMessages(uid,list=>{messages=list;renderMessages();void runtime.markAdminRead(uid);});
    await runtime.markAdminRead(uid);input.focus();
  }

  function onSessions(next){
    const incoming=Array.isArray(next)?next:[];
    for(const s of incoming){
      const prev=lastUnread.get(s.firebaseUid);
      const current=Math.max(0,Number(s.adminUnread||0));
      if(!initialSnapshot&&prev!==undefined&&current>prev)notifySession(s);
      lastUnread.set(s.firebaseUid,current);
    }
    sessions=incoming;initialSnapshot=false;renderSessions();
    if(selectedUid){
      const s=selectedSession();
      if(s){subEl.textContent=`${s.flowPage||'-'} • Tahap ${Number(s.flowStep||0)}${s.blocked?' • DIBLOKIR':''}`;navSend.disabled=Boolean(s.blocked);accessToggle.textContent=s.blocked?'Buka Blokir':'Blokir User';accessToggle.classList.toggle('unblock',Boolean(s.blocked));}
    }
  }

  input.addEventListener('input',()=>{button.disabled=!selectedUid||!input.value.trim()});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!selectedUid)return;const text=input.value.trim().slice(0,500);if(!text)return;
    button.disabled=true;const ok=await runtime.sendAdminMessage(selectedUid,selectedSessionId,{id:newId(),text});
    if(ok){input.value='';button.disabled=true;}else{button.disabled=!input.value.trim();}
    input.focus();
  });

  navSend.addEventListener('click',async()=>{
    const s=selectedSession();if(!s)return;if(s.blocked){navStatus.textContent='User sedang diblokir. Buka blokir sebelum memindahkan halaman.';return;}
    const target=String(navTarget.value||'').trim();navSend.disabled=true;navStatus.textContent='Mengirim perintah perpindahan...';
    const ok=await runtime.navigateUser(selectedUid,target);navStatus.textContent=ok?`Perintah dikirim: ${target}`:'Perintah gagal dikirim.';navSend.disabled=Boolean(selectedSession()?.blocked)||!selectedUid;
  });

  accessToggle.addEventListener('click',async()=>{
    const s=selectedSession();if(!s)return;const blocked=!Boolean(s.blocked);accessToggle.disabled=true;navStatus.textContent=blocked?'Memblokir user...':'Membuka blokir user...';
    const ok=await runtime.setBlocked(selectedUid,blocked);navStatus.textContent=ok?(blocked?'User berhasil diblokir.':'Blokir user berhasil dibuka.'):'Perintah gagal dikirim.';accessToggle.disabled=!selectedUid;
  });

  async function init(){
    await Promise.resolve(window.KBFirebaseBoot);runtime=window.KBFirebaseRuntime;
    if(!runtime?.isAdminConfigured?.()){location.replace('admin-login-firebase.html');return;}
    const admin=await runtime.requireAdmin();if(!admin){location.replace('admin-login-firebase.html');return;}
    stopSessions=await runtime.listenAdminSessions(onSessions);
    renderSessions();
  }

  const arm=()=>{void armNotifications()};
  window.addEventListener('pointerdown',arm,{once:true,capture:true});window.addEventListener('keydown',arm,{once:true,capture:true});
  window.addEventListener('pagehide',()=>{try{stopSessions?.()}catch{}try{stopMessages?.()}catch{}});
  void init();
})();
