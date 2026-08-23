/* Waz — apresentação interativa (v2). Voz ao vivo, áudio gravado, texto e botões. */
(function () {
  'use strict';
  var script = document.currentScript;
  var ENDPOINT = (script && script.dataset.endpoint) || 'http://localhost:8787';
  var MIC_RATE = 16000, OUT_RATE = 24000, ECHO_GATE = 0.035;

  var $ = function (id) { return document.getElementById(id); };
  var hero = $('hero'), stage = $('stage'), caption = $('caption'), visual = $('visual'),
      options = $('options'), avatar = $('avatar'), liveEl = $('live'), liveBtn = $('liveBtn'),
      textIn = $('text'), sendBtn = $('sendBtn');

  // ---------- tracking (funil + UTMs) ----------
  var SID = (function () { try { var k = 'waz_sid', v = sessionStorage.getItem(k); if (!v) { v = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); sessionStorage.setItem(k, v); } return v; } catch (e) { return 'anon' + Date.now(); } })();
  var ATTR = (function () {
    var q = new URLSearchParams(location.search), a = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid'].forEach(function (k) { if (q.get(k)) a[k] = q.get(k); });
    try { var saved = JSON.parse(localStorage.getItem('waz_attr') || '{}'); a = Object.assign({}, saved, a); localStorage.setItem('waz_attr', JSON.stringify(a)); } catch (e) {}
    a.referrer = document.referrer || ''; a.pagina = location.href; a.device = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop'; a.lang = navigator.language;
    return a;
  })();
  function track(evento, dados) {
    var body = JSON.stringify({ sid: SID, evento: evento, dados: dados || {}, attr: ATTR, ts: new Date().toISOString() });
    try { fetch(ENDPOINT + '/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, credentials: 'omit' }).catch(function () {}); } catch (e) {}
  }
  track('page_view');
  document.addEventListener('click', function (e) { var a = e.target.closest && e.target.closest('[data-ev]'); if (a) track(a.getAttribute('data-ev'), { href: a.href }); });

  // ---------- estado ----------
  var ws = null, micCtx = null, micStream = null, micNode = null, outCtx = null, playHead = 0, sources = [];
  var micLvl = 0, micPeak = 0, connected = false, micBlocked = false;
  var liveMode = false, recording = false, active = false, startedAt = 0, leadSent = false;
  var transcript = [], curOut = '', curIn = '';
  var resumeHandle = null, reconnecting = false, setupCfg = null;

  // ---------- visuais ----------
  var F = [
    ['Qualificação de leads', 'As perguntas certas para separar curioso de comprador. Seu time fala só com quem está pronto.'],
    ['Agendamento inteligente', 'O Waz consulta a agenda, oferece horários livres e confirma sozinho, direto na conversa.'],
    ['Envio de propostas', 'O Waz monta a proposta e envia na própria conversa, sem fila e sem espera.'],
    ['Pix e confirmação de pagamento', 'Fecha a venda, envia o Pix e reconhece o pagamento na hora.'],
    ['Follow-up automático', 'Lead sumiu? O Waz retoma a conversa no momento certo, com naturalidade.'],
    ['Reativação de clientes', 'Varre sua base parada e puxa assunto com quem sumiu. Cliente antigo vira receita nova.'],
  ];
  function carousel(title, slides) {
    var h = '<div class="vpad" style="padding-bottom:0"><div class="vtitle">' + title + '</div></div><div class="carousel">';
    slides.forEach(function (s) { h += '<div class="slide">' + s + '</div>'; });
    h += '</div><div class="dots">' + slides.map(function (_, i) { return '<i class="' + (i ? '' : 'on') + '"></i>'; }).join('') + '</div>';
    return h;
  }
  var FICONS = { qualificacao: '🎯', agendamento: '📅', propostas: '📄', pix: '💸', followup: '🔁', reativacao: '♻️' };
  var FKEYS = ['qualificacao', 'agendamento', 'propostas', 'pix', 'followup', 'reativacao'];
  function funcaoSlide(i) {
    return '<div class="big"><div class="big-ic">' + FICONS[FKEYS[i]] + '</div><div class="vtitle">Função ' + (i + 1) + ' de 6</div><h3>' + F[i][0] + '</h3><p>' + F[i][1] + '</p></div>';
  }
  var CRM_ITENS = [['crm_funil', 'Funil visual em tempo real', 'Você abre o painel e sabe exatamente quem está pronto para fechar.'], ['crm_automatico', 'Leads movidos de fase automaticamente', 'Conforme a conversa avança, o lead muda de etapa sozinho.'], ['crm_historico', 'Histórico completo de cada conversa', 'Tudo que foi dito fica registrado, organizado por cliente.']];
  function crmSlide(k) {
    var it = CRM_ITENS.find(function (c) { return c[0] === k; });
    return '<img class="full crm-img" src="crm.png" alt="CRM do Waz" /><div class="vpad"><div class="vtitle">CRM 100% guiado por IA</div><h3 class="h3">' + it[1] + '</h3><p class="p">' + it[2] + '</p></div>';
  }
  var CMP = [['Custo mensal', 'R$ 3.500+ com encargos', 'Menos que um SDR'], ['Horário', 'Máximo 8h por dia', '24h por dia'], ['Dias', 'Segunda a sexta', 'Domingo a domingo'], ['Resposta', 'Minutos a horas', 'Segundos'], ['Férias / turnover', 'Sim, treino do zero', 'Nunca. Treinou uma vez, fica'], ['Conversas ao mesmo tempo', '1 por vez', 'Todas']];
  function cmpSlide(withWaz) {
    var h = '<div class="vpad"><div class="vtitle">' + (withWaz ? 'SDR júnior × Waz' : 'Quanto custa um SDR júnior?') + '</div><table class="cmp' + (withWaz ? ' two' : '') + '"><tr><th></th><th>SDR júnior</th>' + (withWaz ? '<th class="w">Waz</th>' : '') + '</tr>';
    CMP.forEach(function (r, i) { h += '<tr style="animation-delay:' + (i * 90) + 'ms"><td>' + r[0] + '</td><td>' + r[1] + '</td>' + (withWaz ? '<td class="w">' + r[2] + '</td>' : '') + '</tr>'; });
    return h + '</table></div>';
  }
  var VIS = {
    exemplo_conversa:
      '<div class="vpad"><div class="vtitle">Nunca mais deixe um lead morrer sem resposta</div><div class="chat">' +
      '<div class="phone"><div class="hd bad">Sem o Waz · resposta no dia seguinte</div>' +
      '<div class="msg">Oi! Vocês têm horário amanhã à tarde?<small>19:02</small></div><div class="msg">Oi? 😕<small>20:15</small></div>' +
      '<div class="msg">Consegui em outra clínica, obrigada!<small>08:37</small></div><span class="tag bad">Venda perdida</span></div>' +
      '<div class="phone good"><div class="hd ok">Com o Waz · resposta em 3 segundos</div>' +
      '<div class="msg">Oi! Vocês têm horário amanhã à tarde?<small>19:02</small></div>' +
      '<div class="msg me">Oi! Temos sim 😊 Amanhã às 15h ou às 17h30. Qual prefere?<small>19:02 ✓✓</small></div>' +
      '<div class="msg">17h30!<small>19:03</small></div><div class="msg me">Agendado! ✅ Te envio um lembrete amanhã.<small>19:03 ✓✓</small></div>' +
      '<span class="tag ok">O Waz cuidou de tudo</span></div></div>' +
      '<p style="margin:12px 0 0;font-size:13px;color:#5c6664"><b style="color:#16a34a">21x</b> mais chances de fechar quando a resposta chega em menos de 5 minutos.</p></div>',
    como_funciona: '<div class="vpad"><div class="vtitle">Entregue pronto em até 7 dias</div><div class="steps">' +
      '<div class="step"><b>1</b><div><h4>Diagnóstico</h4><p>Entendemos a fundo o seu negócio: produtos, serviços, preços, condições e tom de voz.</p></div></div>' +
      '<div class="step"><b>2</b><div><h4>Treinamento</h4><p>Treinamos e configuramos o Waz no WhatsApp do seu negócio e colocamos ele no ar.</p></div></div>' +
      '<div class="step"><b>3</b><div><h4>Acompanhamento</h4><p>Nosso time acompanha e ajuda você durante todo o período contratado.</p></div></div></div></div>',
    preco: '<div class="price"><div class="name">Waz Essential · plano único</div><div class="val">R$ 2.000<span>/mês</span></div>' +
      '<ul><li>O Waz completo, sem módulos escondidos</li><li>Entregue pronto e funcionando em até 7 dias</li><li>4 mentorias em grupo por mês</li><li>Todas as atualizações futuras inclusas</li></ul>' +
      '<div class="guar">Garantia de resultado · reembolso de 100%, sem burocracia</div></div>',
    quem_esta_por_tras: '<img class="full" src="inner-ai.png" alt="Time Inner AI" /><div class="vpad"><div class="vtitle">Squad.com · grupo Inner AI</div>' +
      '<div class="stats"><div><b>+1M</b><span>usuários atendidos</span></div><div><b>R$ 50M</b><span>captados em investimento</span></div><div><b>#1</b><span>plataforma de IA do Brasil</span></div></div>' +
      '<div class="media"><span>NA MÍDIA</span><img src="midia-1.svg" alt=""><img src="midia-2.svg" alt=""><img src="midia-3.svg" alt=""><img src="midia-4.svg" alt=""></div>' +
      '<p style="font-size:12px;color:#5c6664;margin:10px 0 0">Clientes como Brigadayros e Brasil Grãos · SOC II · Criptografia de nível bancário · Seus dados nunca treinam modelos.</p></div>',
    depoimentos: carousel('O que dizem nossos clientes', [
      '<div class="quote">“O Squad não só automatizou nosso atendimento. Ele destravou o crescimento da empresa.”<footer>Júlia Nussbacker · CEO &amp; Founder, Brigadayros</footer></div>',
      '<div class="quote">“O cliente não consegue perceber que tá falando com uma IA. Realmente é um vendedor.”<footer>Ariane Lima · Gerente Comercial, Brasil Grãos</footer></div>',
    ]),
  };
  var slot = $('slot'), pendingVisual = null;
  // Encaixa o conteúdo do palco no espaço disponível (sem rolagem): reduz a escala se precisar.
  function fitSlot(el) {
    el.style.transform = ''; el.style.marginBottom = '';
    requestAnimationFrame(function () {
      var avail = slot.clientHeight, h = el.offsetHeight;
      if (h > avail && avail > 0) {
        var k = Math.max(0.82, avail / h); // nunca encolhe mais que 18%; o resto rola dentro do palco
        el.style.transform = 'scale(' + k + ')';
        el.style.marginBottom = (-(h * (1 - k))) + 'px'; // compensa o espaço de layout sem encolher a caixa
      }
    });
    // refaz quando imagens carregarem ou o tamanho mudar
    el.querySelectorAll('img').forEach(function (im) { if (!im.complete) im.addEventListener('load', function () { fitSlot(el); }, { once: true }); });
  }
  var ro = window.ResizeObserver ? new ResizeObserver(function () { if (visual.classList.contains('show')) fitSlot(visual); else if (!options.classList.contains('hidden')) fitSlot(options); }) : null;
  if (ro) ro.observe(slot);
  var leadData = {};
  var CAL_URL = 'https://cal.com/squad-vendas/demo', IG_URL = 'https://www.instagram.com/squadcom_br/';
  var WA_NUMBER = (script && script.dataset.whatsapp) || '5500000000000'; // número do Waz com DDI+DDD (data-whatsapp no <script>)
  var WA_MSG = 'Olá, vim da ligação e gostaria de tirar mais algumas dúvidas.';
  function waLink() { return 'https://wa.me/' + WA_NUMBER.replace(/\D/g, '') + '?text=' + encodeURIComponent(WA_MSG); }
  function calLink() {
    var q = new URLSearchParams();
    if (leadData.nome) q.set('name', leadData.nome);
    if (leadData.email) q.set('email', leadData.email);
    if (leadData.whatsapp) { q.set('attendeePhoneNumber', '+55' + leadData.whatsapp.replace(/\D/g, '')); q.set('phone', '+55' + leadData.whatsapp.replace(/\D/g, '')); }
    q.set('notes', 'Lead da apresentação do Waz' + (leadData.empresa ? ' · ' + leadData.empresa : ''));
    return CAL_URL + '?' + q.toString();
  }
  VIS.agendar = function () {
    return '<div class="cal-wrap"><div class="vtitle" style="padding:14px 16px 0">Escolha o melhor horário</div><div id="cal-inline" class="cal-inline"></div>' +
      '<a class="cal-fallback" href="' + calLink() + '" target="_blank" rel="noopener" data-ev="calendar_click">Abrir o calendário em outra aba</a></div>';
  };
  function mountCal() {
    var el = document.getElementById('cal-inline'); if (!el) return;
    (function (C, A, L) { var p = function (a, ar) { a.q.push(ar); }; var d = C.document; C.Cal = C.Cal || function () { var cal = C.Cal, ar = arguments; if (!cal.loaded) { cal.ns = {}; cal.q = cal.q || []; d.head.appendChild(d.createElement('script')).src = A; cal.loaded = true; } if (ar[0] === L) { var api = function () { p(api, arguments); }, namespace = ar[1]; api.q = api.q || []; if (typeof namespace === 'string') { cal.ns[namespace] = cal.ns[namespace] || api; p(cal.ns[namespace], ar); p(cal, ['initNamespace', namespace]); } else p(cal, ar); return; } p(cal, ar); }; })(window, 'https://app.cal.com/embed/embed.js', 'init');
    window.Cal('init', 'waz', { origin: 'https://app.cal.com' });
    window.Cal.ns.waz('inline', { elementOrSelector: '#cal-inline', calLink: 'squad-vendas/demo', layout: 'month_view',
      config: { name: leadData.nome || '', email: leadData.email || '', attendeePhoneNumber: leadData.whatsapp ? '+55' + leadData.whatsapp.replace(/\D/g, '') : '', notes: 'Lead da apresentação do Waz' + (leadData.empresa ? ' · ' + leadData.empresa : ''), theme: 'light' } });
    window.Cal.ns.waz('ui', { hideEventTypeDetails: true, layout: 'month_view', cssVarsPerTheme: { light: { 'cal-brand': '#16a34a' } } });
    window.Cal.ns.waz('on', { action: 'bookingSuccessful', callback: function () { track('calendar_booked'); sendText('Acabei de agendar pelo calendário.', 'Agendado'); } });
    track('calendar_shown');
  }
  VIS.whatsapp = function () {
    return '<div class="cta-card"><div class="vtitle">Continue comigo no WhatsApp</div>' +
      '<p>Tire suas dúvidas direto comigo e veja, na prática, como eu atendo. A mensagem já vai pronta.</p>' +
      '<a class="cta-btn wa-btn" href="' + waLink() + '" target="_blank" rel="noopener" data-ev="whatsapp_click">Falar com o Waz no WhatsApp</a>' +
      '<small>Abre o WhatsApp</small></div>';
  };
  VIS.instagram = '<div class="cta-card ig"><img src="waz-mascote.png" alt="Waz" class="ig-img" /><div class="vtitle">Acompanhe a Squad no Instagram</div>' +
      '<p>Novidades, bastidores e casos reais de clientes usando o Waz.</p>' +
      '<a class="cta-btn ig-btn" href="' + IG_URL + '" target="_blank" rel="noopener" data-ev="instagram_click">Seguir @squadcom_br</a></div>';

  FKEYS.forEach(function (k, i) { VIS['funcao_' + k] = funcaoSlide(i); });
  CRM_ITENS.forEach(function (c) { VIS[c[0]] = crmSlide(c[0]); });
  VIS.comparativo_sdr = cmpSlide(false);
  VIS.comparativo_waz = cmpSlide(true);

  function showVisual(id) {
    if (!id || id === 'nenhum' || !VIS[id]) { visual.classList.remove('show'); pendingVisual = null; return; }
    if (!options.classList.contains('hidden')) { pendingVisual = id; return; } // opções têm prioridade; visual entra após a resposta
    visual.classList.remove('show');
    setTimeout(function () {
      visual.innerHTML = typeof VIS[id] === 'function' ? VIS[id]() : VIS[id];
      var car = visual.querySelector('.carousel');
      if (car) car.addEventListener('scroll', function () {
        var i = Math.round(car.scrollLeft / (car.firstElementChild.offsetWidth + 12));
        visual.querySelectorAll('.dots i').forEach(function (d, k) { d.classList.toggle('on', k === i); });
      });
      visual.classList.add('show');
      if (id === 'agendar') { visual.classList.add('tall'); mountCal(); } else { visual.classList.remove('tall'); fitSlot(visual); }
    }, 150);
  }

  // ---------- botões de resposta ----------
  var lastQuestion = '';
  function showOptions(args) {
    var opts = args.opcoes || [];
    lastQuestion = args.pergunta || ''; track('pergunta_mostrada', { pergunta: lastQuestion });
    var h = '<div class="q">' + esc(args.pergunta || '') + '</div><div class="opts">';
    opts.forEach(function (o) { h += '<button class="opt">' + esc(o) + '</button>'; });
    h += '</div>';
    if (args.permite_digitar) h += '<div class="other"><input id="otherIn" placeholder="Ou digite outra resposta…" /><button id="otherBtn">OK</button></div>';
    visual.classList.remove('show');
    options.innerHTML = h;
    options.classList.remove('hidden');
    fitSlot(options);
    options.querySelectorAll('.opt').forEach(function (b) { b.addEventListener('click', function () { b.classList.add('sel'); setTimeout(function () { answer(b.textContent); }, 120); }); });
    var oi = $('otherIn'), ob = $('otherBtn');
    if (ob) { ob.addEventListener('click', function () { if (oi.value.trim()) answer(oi.value.trim()); }); oi.addEventListener('keydown', function (e) { if (e.key === 'Enter' && oi.value.trim()) answer(oi.value.trim()); }); }
  }
  function showConfirm(d) {
    leadData = { nome: d.nome || '', email: d.email || '', whatsapp: (d.whatsapp || '').replace(/\D/g, ''), empresa: d.empresa || '' };
    visual.classList.remove('show');
    options.innerHTML = '<div class="q">Confere se está tudo certo:</div>' +
      '<div class="fields">' +
      '<label>Nome<input id="cf-nome" value="' + esc(leadData.nome) + '"></label>' +
      '<label>Empresa<input id="cf-empresa" value="' + esc(leadData.empresa) + '"></label>' +
      '<label>E-mail<input id="cf-email" type="email" value="' + esc(leadData.email) + '"></label>' +
      '<label>WhatsApp (com DDD)<input id="cf-whats" inputmode="tel" value="' + esc(leadData.whatsapp) + '"></label>' +
      '</div><button class="opt ok" id="cf-ok">Está tudo certo ✓</button>';
    options.classList.remove('hidden'); fitSlot(options);
    $('cf-ok').addEventListener('click', function () {
      leadData = { nome: $('cf-nome').value.trim(), empresa: $('cf-empresa').value.trim(), email: $('cf-email').value.trim(), whatsapp: $('cf-whats').value.replace(/\D/g, '') };
      track('dados_confirmados', leadData);
      hideOptions();
      sendText('Dados confirmados: nome=' + leadData.nome + '; empresa=' + leadData.empresa + '; email=' + leadData.email + '; whatsapp=' + leadData.whatsapp, 'Dados confirmados');
    });
  }
  function hideOptions() { options.classList.add('hidden'); options.innerHTML = ''; options.style.transform = ''; options.style.marginBottom = ''; }
  function answer(text) { track('resposta_opcao', { pergunta: lastQuestion, resposta: text }); hideOptions(); sendText('Resposta: ' + text, text); if (pendingVisual) { var pv = pendingVisual; pendingVisual = null; showVisual(pv); } }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---------- áudio ----------
  var workletCode = 'class C extends AudioWorkletProcessor{constructor(){super();this.b=[];this.n=0}process(i){var c=i[0][0];if(!c)return true;this.b.push(new Float32Array(c));this.n+=c.length;if(this.n>=2048){var a=new Float32Array(this.n),o=0;for(var k=0;k<this.b.length;k++){a.set(this.b[k],o);o+=this.b[k].length}this.b=[];this.n=0;this.port.postMessage(a,[a.buffer])}return true}}registerProcessor("waz-cap",C);';
  function rms(f) { var s = 0; for (var i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / f.length); }
  function isSpeaking() { return outCtx && playHead > outCtx.currentTime + 0.02; }
  function to16k(f, from) { var r = from / MIC_RATE, n = Math.floor(f.length / r), o = new Int16Array(n); for (var i = 0; i < n; i++) { var x = i * r, lo = Math.floor(x), hi = Math.min(lo + 1, f.length - 1); var s = f[lo] + (f[hi] - f[lo]) * (x - lo); s = Math.max(-1, Math.min(1, s)); o[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return o; }
  function b64(i16) { var b = new Uint8Array(i16.buffer), s = ''; for (var i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); }
  function fromB64(s) { var bin = atob(s), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); var i16 = new Int16Array(b.buffer), f = new Float32Array(i16.length); for (var j = 0; j < i16.length; j++) f[j] = i16[j] / 32768; return f; }

  async function ensureMic() {
    if (micCtx) return true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { micBlocked = true; liveEl.className = 'live muted'; liveEl.querySelector('span').textContent = 'Microfone bloqueado · pode digitar'; return false; }
    micCtx = new (window.AudioContext || window.webkitAudioContext)();
    await micCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([workletCode], { type: 'text/javascript' })));
    micNode = new AudioWorkletNode(micCtx, 'waz-cap');
    micNode.port.onmessage = function (e) {
      if (!ws || ws.readyState !== 1) return;
      micLvl = rms(e.data);
      if (!liveMode && !recording) return;
      if (liveMode && isSpeaking() && rms(e.data) < ECHO_GATE) return; // portão anti-eco só no modo ao vivo
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(to16k(e.data, micCtx.sampleRate)), mimeType: 'audio/pcm;rate=16000' } } }));
    };
    micCtx.createMediaStreamSource(micStream).connect(micNode);
    return true;
  }
  function playChunk(data) {
    if (!outCtx) return;
    var f = fromB64(data), buf = outCtx.createBuffer(1, f.length, OUT_RATE); buf.getChannelData(0).set(f);
    var src = outCtx.createBufferSource(); src.buffer = buf; src.connect(analyser || outCtx.destination);
    var now = outCtx.currentTime; if (playHead < now + 0.05) playHead = now + 0.25; // buffer inicial evita engasgo quando a rede oscila
    src.start(playHead); playHead += buf.duration; sources.push(src);
    src.onended = function () { sources = sources.filter(function (s) { return s !== src; }); };
  }
  var analyser = null, anBuf = null;
  function setupAnalyser() {
    analyser = outCtx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.5;
    analyser.connect(outCtx.destination); anBuf = new Uint8Array(analyser.fftSize);
  }
  function outLevel() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(anBuf);
    var sum = 0; for (var i = 0; i < anBuf.length; i++) { var v = (anBuf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / anBuf.length);
  }
  function stopPlayback() { capLastT = 0; sources.forEach(function (s) { try { s.stop(); } catch (e) {} }); sources = []; playHead = 0; }

  // ---------- vídeo do rosto dirigido pela energia da voz ----------
  // A boca se mexe só quando há voz (pausa nas pausas) e a velocidade acompanha a intensidade.
  var vids = [$('vid1'), $('vid2')], vi = 0, wasSpeaking = false, mouthOn = false, quietSince = 0, lvl = 0;
  vids[0].classList.add('on');
  function switchFace() {
    var old = vids[vi]; vi = 1 - vi; var nv = vids[vi];
    try { nv.currentTime = Math.random() * Math.max(0, (nv.duration || 10) - 3); } catch (e) {}
    nv.classList.add('on'); old.classList.remove('on');
    setTimeout(function () { old.pause(); }, 300);
  }
  function driveMouth(now) {
    var v = vids[vi];
    var raw = outLevel();
    lvl = lvl * 0.6 + raw * 0.4;                       // suaviza
    var ON = 0.035, OFF = 0.015;
    if (!mouthOn && lvl > ON) { mouthOn = true; v.play().catch(function () {}); }
    else if (mouthOn && lvl < OFF) { if (!quietSince) quietSince = now; if (now - quietSince > 140) { mouthOn = false; v.pause(); } }
    if (lvl >= OFF) quietSince = 0;
    if (mouthOn) v.playbackRate = Math.max(0.85, Math.min(1.3, 0.85 + lvl * 2.5));
  }
  (function tick(now) {
    var sp = !!isSpeaking();
    avatar.classList.toggle('speaking', sp);
    if (sp !== wasSpeaking) { wasSpeaking = sp; if (sp) switchFace(); else { mouthOn = false; vids[vi].pause(); } }
    if (sp) driveMouth(now || performance.now());
    updateMicChip(now || performance.now());
    renderCaption(); requestAnimationFrame(tick);
  })(performance.now());

  // ---------- sessão ----------
  // Legenda sincronizada com o áudio, exibida por FRASE (quebra só em pontuação).
  // Cada palavra recebe um instante na linha do tempo do player (outCtx) e aparece quando o som chega nela.
  var capWords = [], capLine = [], capLastT = 0, capBreak = false, SEC_PER_WORD = 0.30;
  function fixName(t) { return t.replace(/\b[UuVvOo]+[oóôáa]?[zs]\b/g, function (m) { return /^(os|us|oz|vaz|vos)$/i.test(m) && !/^[UuOo]/.test(m) ? m : (/^(u[oóôáa][zs]|v[oóôáa][zs]|oo[zs]|uaz|uos)$/i.test(m) ? 'Waz' : m); }); }
  function feedCaption(chunk) {
    if (!outCtx) return;
    var words = fixName(chunk).split(/\s+/).filter(Boolean);
    if (!words.length) return;
    var now = outCtx.currentTime;
    // Linha do tempo sequencial: cada trecho ocupa o áudio ainda não "legendado" (de capLastT até playHead).
    var start = capLastT > 0 ? capLastT : Math.max(now, playHead - 0.4);
    if (start < now - 0.6) start = now - 0.2;                      // transcrição atrasada: mostra já
    var end = playHead;
    if (end < start + words.length * 0.2) end = start + words.length * SEC_PER_WORD; // transcrição adiantada: estima pelo ritmo
    var step = (end - start) / words.length;
    words.forEach(function (w, i) { capWords.push({ w: w, t: start + step * i }); });
    capLastT = end;
  }
  // Legenda cinética: UMA linha, poucas palavras por vez, cada palavra entra no instante do som.
  var CAP_WORDS = 7;
  function renderCaption() {
    if (!outCtx || !capWords.length) return;
    var now = outCtx.currentTime, changed = false;
    while (capWords.length && capWords[0].t <= now) {
      var w = capWords.shift().w;
      if (capBreak || capLine.length >= CAP_WORDS) { capLine = []; capBreak = false; }
      capLine.push(w); changed = true;
      if (/[.!?…,;:]["”)]?$/.test(w)) capBreak = true;   // pontuação fecha o bloco
    }
    if (changed) {
      caption.classList.remove('status');
      caption.innerHTML = '<span>' + capLine.map(function (x, i) {
        return '<em' + (i === capLine.length - 1 ? ' class="new"' : '') + '>' + esc(x) + '</em>';
      }).join(' ') + '</span>';
    }
  }
  var capLine = [];
  function resetCaption() { capWords = []; capLine = []; capLastT = 0; capBreak = false; }
  function setCaption(t, status) { resetCaption(); caption.textContent = t; caption.classList.toggle('status', !!status); }
  function setLive(on, label) { liveEl.classList.toggle('on', on); liveEl.querySelector('span').textContent = label; }
  var lvBars = liveEl.querySelectorAll('.lv b'), hearingUntil = 0;
  function updateMicChip(now) {
    if (!active || !ws || !connected) return;
    if (micBlocked) { liveEl.className = 'live muted'; liveEl.querySelector('span').textContent = 'Microfone bloqueado · pode digitar'; return; }
    if (!liveMode) { liveEl.className = 'live muted'; liveEl.querySelector('span').textContent = 'Microfone desligado'; return; }
    var talking = micLvl > 0.02 && !isSpeaking();
    if (talking) hearingUntil = now + 600;
    var hearing = now < hearingUntil;
    liveEl.className = 'live on' + (hearing ? ' hearing' : '');
    liveEl.querySelector('span').textContent = hearing ? 'Ouvindo você' : 'Ao vivo · microfone ligado';
    if (hearing) { micPeak = Math.max(micLvl, micPeak * 0.85); var h = Math.min(12, 3 + micPeak * 60);
      lvBars[0].style.height = (h * 0.6) + 'px'; lvBars[1].style.height = h + 'px'; lvBars[2].style.height = (h * 0.75) + 'px'; }
  }

  async function start() {
    if (active) return; active = true; leadSent = false; transcript = [];
    track('start_click');
    hero.classList.add('hidden'); stage.classList.add('on'); window.scrollTo(0, 0);
    vids.forEach(function (v) { v.play().then(function () { v.pause(); v.currentTime = 0; }).catch(function () {}); });
    outCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_RATE });
    setupAnalyser();
    try {
      var res = await fetch(ENDPOINT + '/token?v=2', { method: 'POST' });
      var cfg = await res.json(); if (!res.ok || cfg.error) throw new Error(cfg.error || res.status);
      if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
      ws = new WebSocket(cfg.wsUrl);
      var mine = ws, chain = Promise.resolve();
      ws.onopen = function () { mine.send(JSON.stringify(cfg.setup)); };
      ws.onmessage = function (ev) {
        chain = chain.then(function () { return ev.data instanceof Blob ? ev.data.text() : ev.data; })
          .then(function (txt) { if (ws === mine) handle(JSON.parse(txt)); }).catch(function () {});
      };
      ws.onerror = function () { setCaption('Falha na conexão. Tente de novo em instantes.', true); };
      setupCfg = cfg;
      ws.onclose = function (e) { if (!active || ws !== mine) return; if (resumeHandle && !reconnecting) reconnect(); else end(true); };
      startedAt = Date.now();
      // tenta ligar o microfone ao vivo por padrão (ligação); se negar, segue por texto/botões
      if (await ensureMic()) toggleLive(true);
    } catch (e) { setCaption('Não consegui conectar agora. Tente de novo em instantes.', true); }
  }

  async function reconnect() {
    reconnecting = true; stopPlayback(); setLive(false, 'Reconectando…');
    try {
      var res = await fetch(ENDPOINT + '/token?v=2', { method: 'POST' });
      var cfg = await res.json(); if (!res.ok || cfg.error) throw new Error('token');
      cfg.setup.setup.sessionResumption = { handle: resumeHandle };
      var nws = new WebSocket(cfg.wsUrl), mine = nws, chain = Promise.resolve();
      ws = nws;
      nws.onopen = function () { mine.send(JSON.stringify(cfg.setup)); };
      nws.onmessage = function (ev) {
        chain = chain.then(function () { return ev.data instanceof Blob ? ev.data.text() : ev.data; })
          .then(function (txt) { if (ws === mine) handle(JSON.parse(txt)); }).catch(function () {});
      };
      nws.onclose = function () { if (!active || ws !== mine) return; end(true); };
      nws.onerror = function () {};
    } catch (e) { end(true); }
  }
  function handle(msg) {
    if (msg.sessionResumptionUpdate) { if (msg.sessionResumptionUpdate.resumable && msg.sessionResumptionUpdate.newHandle) resumeHandle = msg.sessionResumptionUpdate.newHandle; return; }
    if (msg.setupComplete && reconnecting) { reconnecting = false; connected = true; setLive(true, 'Ao vivo · microfone ligado'); return; }
    if (msg.setupComplete) {
      connected = true; setLive(true, 'Ao vivo · microfone ligado'); track('conectado', { mic: liveMode });
      setCaption('', true);
      ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'O visitante acabou de clicar em Começar. Faça sua abertura.' }] }], turnComplete: true } }));
      return;
    }
    var sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) { stopPlayback(); resetCaption(); return; }
      if (sc.inputTranscription && sc.inputTranscription.text) { curIn += sc.inputTranscription.text; }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        if (curIn) { push('cliente', curIn); curIn = ''; }
        curOut += fixName(sc.outputTranscription.text); feedCaption(sc.outputTranscription.text);
      }
      (sc.modelTurn && sc.modelTurn.parts || []).forEach(function (p) { if (p.inlineData && p.inlineData.data) playChunk(p.inlineData.data); });
      if (sc.turnComplete) { if (curOut) { push('waz', curOut); curOut = ''; } capLastT = 0; }
    }
    if (msg.toolCall && msg.toolCall.functionCalls) {
      msg.toolCall.functionCalls.forEach(function (fc) {
        (window.__wazLog = window.__wazLog || []).push(fc.name + ' ' + JSON.stringify(fc.args));
        if (fc.name === 'mostrar_visual') { track('visual', { id: fc.args && fc.args.id }); showVisual(fc.args && fc.args.id); }
        else if (fc.name === 'perguntar_opcoes') showOptions(fc.args || {});
        else if (fc.name === 'confirmar_dados') showConfirm(fc.args || {});
        else if (fc.name === 'registrar_lead') sendLead(fc.args || {});
        ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result: 'ok' } }] } }));
      });
    }
    if (msg.goAway && resumeHandle && !reconnecting) { try { ws.onclose = null; ws.close(); } catch (e) {} reconnect(); }
  }
  function push(role, text) { transcript.push({ role: role, text: fixName(text) }); }

  function sendText(payload, shown) {
    if (!ws || ws.readyState !== 1) return;
    stopPlayback(); curOut = ''; resetCaption();
    push('cliente', shown || payload);
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: payload }] }], turnComplete: true } }));
  }
  function sendLead(args) {
    if (leadSent) return; leadSent = true;
    track('lead_registrado', args);
    fetch(ENDPOINT + '/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      sid: SID, attr: ATTR, origem: 'lp-apresentacao-waz', pagina: location.href, data: new Date().toISOString(),
      duracao_seg: Math.floor((Date.now() - startedAt) / 1000), lead: args, transcricao: transcript }) }).catch(function () {});
  }

  // ---------- controles ----------
  function toggleLive(force) {
    liveMode = typeof force === 'boolean' ? force : !liveMode;
    if (liveMode) recording = false;
    liveBtn.classList.toggle('on', liveMode);
    liveBtn.querySelector('small').textContent = liveMode ? 'Ligado' : 'Mudo';
  }
  liveBtn.addEventListener('click', async function () { if (!(await ensureMic())) return; toggleLive(); });
  function sendTyped() { var t = textIn.value.trim(); if (!t) return; textIn.value = ''; track('texto_enviado', { texto: t }); hideOptions(); sendText(t); if (pendingVisual) { var pv = pendingVisual; pendingVisual = null; showVisual(pv); } }
  sendBtn.addEventListener('click', sendTyped);
  textIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendTyped(); });

  function end(fromServer) {
    if (active) track('encerrado', { por: fromServer ? 'servidor' : 'usuario', duracao_seg: Math.floor((Date.now() - startedAt) / 1000), transcricao: transcript.slice(-40) });
    active = false; liveMode = false; recording = false; connected = false; micBlocked = false;
    stopPlayback(); if (ws && ws.readyState <= 1) { try { ws.close(); } catch (e) {} } ws = null;
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    if (micCtx) { micCtx.close().catch(function () {}); micCtx = null; }
    if (outCtx) { outCtx.close().catch(function () {}); outCtx = null; }
    setLive(false, fromServer ? 'Conversa encerrada' : 'Encerrado');
    setCaption('Conversa encerrada. Obrigado pelo papo!', true);
    hideOptions(); showVisual('nenhum');
    setTimeout(function () { stage.classList.remove('on'); hero.classList.remove('hidden'); window.scrollTo(0, 0); }, 2500);
  }
  $('end').addEventListener('click', function () { end(false); });
  window.__wazDebug = { showVisual: showVisual, showConfirm: showConfirm, showOptions: showOptions };
  $('start').addEventListener('click', start);
})();
