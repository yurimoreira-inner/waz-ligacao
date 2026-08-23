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
    try { a.hora_local = new Date().toLocaleString('pt-BR', { hour12: false }); a.fuso = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    return a;
  })();
  // localização aproximada por IP (estado/cidade) — sem pedir permissão; falha silenciosa
  fetch('https://ipwho.is/?fields=region,region_code,city,country_code').then(function (r) { return r.json(); }).then(function (g) {
    if (g && g.region) { ATTR.estado = g.region_code || g.region; ATTR.cidade = g.city || ''; ATTR.pais = g.country_code || ''; track('localizacao', { estado: ATTR.estado, cidade: ATTR.cidade }); }
  }).catch(function () {});
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
  var micAsked = false, userAnswered = false, nudgeTimer = null, spokeSinceOptions = false;
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
      '<div class="stats"><div><b>+3 anos</b><span>em inteligência artificial</span></div><div><b>+1M</b><span>usuários atendidos</span></div><div><b>#1</b><span>plataforma de IA do Brasil</span></div></div>' +
      '<p class="clients"><span>ATENDEMOS</span> Mercado Livre · Movida · Embraer · Brigadayros · Brasil Grãos</p>' +
      '<div class="media"><span>NA MÍDIA</span><img src="midia-1.svg" alt=""><img src="midia-2.svg" alt=""><img src="midia-3.svg" alt=""><img src="midia-4.svg" alt=""></div>' +
      '<p style="font-size:12px;color:#5c6664;margin:10px 0 0">R$ 50M captados · SOC II · Criptografia de nível bancário · Seus dados nunca treinam modelos.</p></div>',
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
  function insight(big, small, src) { return '<div class="big ins"><div class="vtitle">Você sabia?</div><div class="ins-big">' + big + '</div><p>' + small + '</p>' + (src ? '<small>' + src + '</small>' : '') + '</div>'; }
  VIS.insight_magalu = insight('R$ 100 milhões', 'foi o que a <b>Magazine Luiza</b> faturou pelo WhatsApp, com conversão <b>3× maior</b> que nos outros canais.', 'Magazine Luiza · resultados divulgados');
  VIS.insight_whatsapp = insight('O maior canal do mundo', 'Praticamente <b>todo brasileiro conectado</b> usa WhatsApp. Não importa o seu negócio: o seu cliente já está lá.', '');
  VIS.insight_comportamento = insight('O cliente mudou', 'Ele pesquisa, pergunta e compra pelo celular — e quer <b>resposta na hora</b>, onde ele já está.', '');
  VIS.insight_5min = insight('21× mais chances', 'de fechar negócio quando a resposta chega em <b>menos de 5 minutos</b>.', 'Estudo Lead Response Management');
  // ---- pilares ----
  var PILARES = {
    pilar_velocidade: ['1º pilar', 'Velocidade', 'Quem mais vende não é quem tem o melhor preço. É quem responde primeiro: na 1ª hora, a chance de converter é até <b>7× maior</b>.', '⚡'],
    pilar_resposta: ['2º pilar', 'Resposta assertiva', 'Mensagem automática não é atendimento — é <b>senha de fila</b>. Assertivo é resolver a dúvida, contornar a objeção e conduzir.', '🎯'],
    pilar_qualificacao: ['3º pilar', 'Qualificação', 'Atender todos e separar o <b>curioso</b> do interessado de verdade. O seu tempo (e o do seu time) não pode ir pra curioso.', '🔍'],
  };
  Object.keys(PILARES).forEach(function (k) {
    var it = PILARES[k];
    VIS[k] = '<div class="big"><div class="big-ic">' + it[3] + '</div><div class="vtitle">' + it[0] + ' · Sistema Waz</div><h3>' + it[1] + '</h3><p>' + it[2] + '</p></div>';
  });

  // ---- demo de chat animada: as mensagens entram uma a uma conforme o Waz narra ----
  var DEMO = [
    { fase: 'demo_pergunta', msgs: [
      { de: 'c', t: 'Oi! Vocês têm horário amanhã? Quanto custa?' },
      { de: 'w', digitando: true, t: 'Oi! Temos sim 😊 O valor é R$ 180 e amanhã tenho 10h ou 16h30 livres. Prefere de manhã ou à tarde?' },
    ]},
    { fase: 'demo_agenda', msgs: [
      { de: 'c', t: 'Não consigo amanhã… tem quinta?' },
      { de: 'w', digitando: true, t: 'Tenho sim! Quinta às 11h ou às 17h. Qual fica melhor?' },
      { de: 'c', t: 'Às 17h!' },
      { de: 'w', t: 'Fechado ✅ Quinta, 17h. Vou te mandar um lembrete no dia.' },
    ]},
    { fase: 'demo_pix', msgs: [
      { de: 'c', t: 'Quero deixar reservado!' },
      { de: 'w', digitando: true, t: 'Perfeito! Pra garantir, o sinal é R$ 50. Segue o Pix: 🔑 squad@pix' },
      { de: 's', t: 'Pagamento recebido · R$ 50,00' },
      { de: 'w', t: 'Pagamento confirmado! 🎉 Sua reserva está garantida.' },
    ]},
    { fase: 'demo_follow', msgs: [
      { de: 'c', t: 'Vou ver e te falo…' },
      { de: 'sep', t: 'no dia seguinte' },
      { de: 'w', digitando: true, t: 'Oi! Conseguiu ver? O horário de quinta ainda está disponível — quer que eu segure pra você?' },
      { de: 'c', t: 'Quero sim! Pode marcar 🙌' },
    ]},
  ];
  var demoStage = -1;
  function demoIndex(id) { for (var i = 0; i < DEMO.length; i++) if (DEMO[i].fase === id) return i; return -1; }
  function demoChatHtml(upto, animFrom) {
    var h = '<div class="vpad" style="padding-bottom:8px"><div class="vtitle">Ao vivo · WhatsApp da sua empresa</div></div><div class="demo-chat" id="demo-chat">';
    var n = 0;
    for (var i = 0; i <= upto; i++) DEMO[i].msgs.forEach(function (m) {
      var anim = n >= animFrom;
      var delay = anim ? ((n - animFrom) * 900) : 0;
      if (m.de === 'sep') { h += '<div class="dm-sep' + (anim ? ' dm-in' : '') + '" style="animation-delay:' + delay + 'ms">' + m.t + '</div>'; n++; return; }
      if (m.de === 's') { h += '<div class="dm-sys' + (anim ? ' dm-in' : '') + '" style="animation-delay:' + delay + 'ms">💸 ' + m.t + '</div>'; n++; return; }
      if (m.digitando && anim) h += '<div class="dm dm-w dm-typing" style="animation: dmtyping .1s forwards ' + delay + 'ms, dmhide .2s forwards ' + (delay + 720) + 'ms"><i></i><i></i><i></i></div>';
      h += '<div class="dm ' + (m.de === 'w' ? 'dm-w' : 'dm-c') + (anim ? ' dm-in' : '') + '" style="animation-delay:' + (delay + (m.digitando && anim ? 700 : 0)) + 'ms">' + m.t + '<small>agora' + (m.de === 'w' ? ' ✓✓' : '') + '</small></div>';
      n++;
    });
    return h + '</div>';
  }
  function showDemo(id) {
    var idx = demoIndex(id); if (idx < 0) return;
    var animFrom = 0;
    if (demoStage >= 0 && demoStage < idx && visual.classList.contains('show') && document.getElementById('demo-chat')) {
      animFrom = 0; for (var i = 0; i <= demoStage; i++) animFrom += DEMO[i].msgs.length;
    } else if (demoStage === idx) return;
    demoStage = idx;
    visual.innerHTML = demoChatHtml(idx, animFrom);
    visual.classList.add('show'); visual.classList.remove('tall'); stage.classList.remove('compact');
    var box = document.getElementById('demo-chat');
    if (box) setTimeout(function () { box.scrollTop = box.scrollHeight; }, 60);
    var per = 900, count = DEMO[idx].msgs.length;
    for (var k = 1; k <= count; k++) (function (k) { setTimeout(function () { var b = document.getElementById('demo-chat'); if (b) b.scrollTop = b.scrollHeight; }, k * per + 300); })(k);
    fitSlot(visual);
  }

  VIS.comparativo_sdr = cmpSlide(false);
  VIS.comparativo_waz = cmpSlide(true);

  // Vários slides na mesma fala: em vez de pular todos, distribui ao longo das palavras daquela fala.
  var visQueue = [], visShownInTurn = 0, visTurnTotal = 0, turnLive = false;
  var VIS_IMEDIATOS = { nenhum: 1, agendar: 1, whatsapp: 1, instagram: 1 };
  function queueVisual(id) {
    if (VIS_IMEDIATOS[id]) { visQueue = []; showVisualNow(id); return; }
    visQueue.push(id);
    visTurnTotal = visShownInTurn + visQueue.length;
  }
  function pumpVisualQueue(shownWords) {
    if (!visQueue.length) return;
    var total = turnWords.length || 1;
    // o 1º slide da fala só entra depois de ~4 palavras (a pessoa ouve o assunto primeiro)
    var nextAt = Math.max(4, Math.floor((visShownInTurn / Math.max(1, visTurnTotal)) * total));
    if (shownWords >= nextAt) { showVisualNow(visQueue.shift()); visShownInTurn++; }
  }
  function showVisual(id) { queueVisual(id); }
  function showVisualNow(id) {
    if (id && id.indexOf('demo_') === 0) { hideOptions(); pendingVisual = null; showDemo(id); return; }
    demoStage = -1;
    if (!id || id === 'nenhum' || !VIS[id]) { visual.classList.remove('show'); stage.classList.remove('compact'); pendingVisual = null; return; }
    if (!options.classList.contains('hidden') && !spokeSinceOptions) { pendingVisual = id; return; } // opções têm prioridade até a pessoa responder (clique, texto ou voz)
    if (spokeSinceOptions) hideOptions();
    visual.classList.remove('show');
    setTimeout(function () {
      visual.innerHTML = typeof VIS[id] === 'function' ? VIS[id]() : VIS[id];
      var car = visual.querySelector('.carousel');
      if (car) car.addEventListener('scroll', function () {
        var i = Math.round(car.scrollLeft / (car.firstElementChild.offsetWidth + 12));
        visual.querySelectorAll('.dots i').forEach(function (d, k) { d.classList.toggle('on', k === i); });
      });
      visual.classList.add('show');
      if (id === 'agendar') { visual.classList.add('tall'); stage.classList.add('compact'); showTyping(); mountCal(); } else { visual.classList.remove('tall'); stage.classList.remove('compact'); fitSlot(visual); }
    }, 150);
  }

  // ---------- botões de resposta ----------
  var lastQuestion = '';
  function showOptions(args) {
    var opts = args.opcoes || [];
    lastQuestion = args.pergunta || ''; spokeSinceOptions = false; curIn = ''; track('pergunta_mostrada', { pergunta: lastQuestion });
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
  function showTyping() { stage.classList.add('typing'); }
  function showConfirm(d) {
    showTyping();
    leadData = { nome: d.nome || leadData.nome || '', email: d.email || leadData.email || '', whatsapp: ((d.whatsapp || leadData.whatsapp || '') + '').replace(/\D/g, ''), empresa: d.empresa || leadData.empresa || '' };
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
    } catch (e) { micBlocked = true; showTyping(); liveEl.className = 'live muted'; liveEl.querySelector('span').textContent = 'Microfone bloqueado · pode digitar'; return false; }
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
    if (outCtx.state === 'suspended') outCtx.resume().catch(function () {});
    var f = fromB64(data), buf = outCtx.createBuffer(1, f.length, OUT_RATE); buf.getChannelData(0).set(f);
    var src = outCtx.createBufferSource(); src.buffer = buf; src.connect(analyser || outCtx.destination);
    var now = outCtx.currentTime;
    if (playHead < now + 0.05) { // novo turno de fala do Waz
      playHead = now + 0.25; turnAudioStart = playHead; turnWords = []; capWords = []; capLine = []; capBreak = false; turnShownWords = 0;
      turnLive = true; visShownInTurn = 0; visTurnTotal = visQueue.length; // slides desta fala entram ao longo das palavras (o 1º após ~4)
      if (spokeSinceOptions) { // a pessoa respondeu por voz: a pergunta anterior já era
        if (!options.classList.contains('hidden')) { if (lastQuestion && curIn) track('resposta_opcao', { pergunta: lastQuestion, resposta: curIn.trim(), via: 'voz' }); hideOptions(); if (pendingVisual) { var pv = pendingVisual; pendingVisual = null; showVisual(pv); } }
        spokeSinceOptions = false;
      }
    }
    src.start(playHead); playHead += buf.duration; sources.push(src);
    retimeCaption();
    src.onended = function () { sources = sources.filter(function (s) { return s !== src; }); };
  }
  var analyser = null, anBuf = null, mediaDest = null, audioEl = null;
  function setupAnalyser() {
    analyser = outCtx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.5;
    anBuf = new Uint8Array(analyser.fftSize);
    // Compressor nivelador: mantém o volume percebido constante entre falas
    var comp = outCtx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 18; comp.ratio.value = 3.5; comp.attack.value = 0.01; comp.release.value = 0.22;
    var makeup = outCtx.createGain(); makeup.gain.value = 1.15;
    analyser.disconnect && analyser.disconnect();
    // Saída via elemento <audio> (categoria "mídia"): toca no iPhone mesmo com a chave no silencioso
    // e não depende do microfone estar ativo. Fallback: destino direto do AudioContext.
    try {
      mediaDest = outCtx.createMediaStreamDestination();
      analyser.connect(comp); comp.connect(makeup); makeup.connect(mediaDest);
      audioEl = document.getElementById('wazAudio') || document.createElement('audio');
      audioEl.id = 'wazAudio'; audioEl.setAttribute('playsinline', ''); audioEl.autoplay = true; audioEl.style.display = 'none';
      if (!audioEl.parentNode) document.body.appendChild(audioEl);
      audioEl.srcObject = mediaDest.stream;
      var pr = audioEl.play(); if (pr && pr.catch) pr.catch(function () { makeup.disconnect(); makeup.connect(outCtx.destination); });
    } catch (e) { try { analyser.connect(comp); comp.connect(makeup); makeup.connect(outCtx.destination); } catch (e2) { analyser.connect(outCtx.destination); } }
  }
  function outLevel() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(anBuf);
    var sum = 0; for (var i = 0; i < anBuf.length; i++) { var v = (anBuf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / anBuf.length);
  }
  function stopPlayback() { capLastT = 0; turnAudioStart = 0; turnWords = []; visQueue = []; visShownInTurn = 0; visTurnTotal = 0; turnLive = false; sources.forEach(function (s) { try { s.stop(); } catch (e) {} }); sources = []; playHead = 0; }

  // ---------- rosto fixo; só as ondas indicam a fala ----------
  var wasSpeaking = false;
  (function tick(now) {
    var sp = !!isSpeaking();
    avatar.classList.toggle('speaking', sp);
    if (sp !== wasSpeaking) { wasSpeaking = sp; if (!sp) { turnLive = false; visShownInTurn = 0; while (visQueue.length) showVisualNow(visQueue.shift()); } }
    updateMicChip(now || performance.now());
    if (waitingReply && Date.now() - waitingReply > 14000 && ws && ws.readyState === 1) { waitingReply = 0; ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'O visitante continua aí, esperando. Retome de onde parou, em uma frase.' }] }], turnComplete: true } })); }
    renderCaption(); requestAnimationFrame(tick);
  })(performance.now());

  // ---------- sessão ----------
  // Legenda sincronizada com o áudio, exibida por FRASE (quebra só em pontuação).
  // Cada palavra recebe um instante na linha do tempo do player (outCtx) e aparece quando o som chega nela.
  var capWords = [], capLine = [], capLastT = 0, capBreak = false, SEC_PER_WORD = 0.30;
  function fixName(t) { return t.replace(/\b[UuVvOo]+[oóôáa]?[zs]\b/g, function (m) { return /^(os|us|oz|vaz|vos)$/i.test(m) && !/^[UuOo]/.test(m) ? m : (/^(u[oóôáa][zs]|v[oóôáa][zs]|oo[zs]|uaz|uos)$/i.test(m) ? 'Waz' : m); }); }
  var turnAudioStart = 0, turnWords = [], CAP_LAG = 0.25; // atraso pequeno: o texto costuma chegar antes do som
  function feedCaption(chunk) {
    if (!outCtx) return;
    var words = fixName(chunk).split(/\s+/).filter(Boolean);
    if (!words.length) return;
    words.forEach(function (w) { var o = { w: w, t: Infinity }; turnWords.push(o); capWords.push(o); });
    retimeCaption();
  }
  // Mapeamento proporcional: a i-ésima palavra do turno fica em início + (i / total) × duração de áudio já recebida.
  // Recalculado a cada pacote de texto ou áudio, então se corrige sozinho quando um dos dois chega antes.
  function retimeCaption() {
    if (!outCtx || !turnWords.length) return;
    var start = turnAudioStart || outCtx.currentTime;
    var dur = Math.max(0, playHead - start);
    var n = turnWords.length, weights = [], total = 0;
    for (var i = 0; i < n; i++) { var wgt = 2 + turnWords[i].w.replace(/[^\wÀ-ÿ]/g, '').length + (/[.!?,;:…]$/.test(turnWords[i].w) ? 3 : 0); weights.push(wgt); total += wgt; }
    var rate = dur > 2 ? dur / total : 0.075; // segundos por "unidade de peso" (≈ letra)
    var span = dur > 0 ? Math.max(dur, total * rate * 0.9) : total * rate;
    var acc = 0;
    for (var j = 0; j < n; j++) { turnWords[j].t = start + (acc / total) * span + CAP_LAG; acc += weights[j]; }
  }
  // Legenda cinética: UMA linha, poucas palavras por vez, cada palavra entra no instante do som.
  var CAP_WORDS = 10, turnShownWords = 0;
  function renderCaption() {
    if (!outCtx || !capWords.length) return;
    var now = outCtx.currentTime, changed = false;
    while (capWords.length && capWords[0].t <= now) {
      var w = capWords.shift().w; turnShownWords++;
      if (capBreak || capLine.length >= CAP_WORDS) { capLine = []; capBreak = false; }
      capLine.push(w); changed = true;
      if (/[.!?…,;:]["”)]?$/.test(w)) capBreak = true;   // pontuação fecha o bloco
    }
    if (changed) {
      pumpVisualQueue(turnShownWords);
      caption.classList.remove('status');
      caption.innerHTML = '<span>' + capLine.map(function (x, i) {
        return '<em' + (i === capLine.length - 1 ? ' class="new"' : '') + '>' + esc(x) + '</em>';
      }).join(' ') + '</span>';
    }
  }
  var capLine = [];
  function resetCaption() { capWords = []; capLine = []; capLastT = 0; capBreak = false; turnWords = []; }
  function setCaption(t, status) { resetCaption(); caption.textContent = t; caption.classList.toggle('status', !!status); }
  function setLive(on, label) { liveEl.classList.toggle('on', on); liveEl.querySelector('span').textContent = label; }
  var lvBars = liveEl.querySelectorAll('.lv b'), hearingUntil = 0;
  function updateMicChip(now) {
    if (!active || !ws || !connected) return;
    if (micBlocked) { liveEl.className = 'live muted'; liveEl.querySelector('span').textContent = 'Microfone bloqueado · pode digitar'; return; }
    if (!liveMode) { liveEl.className = micAsked ? 'live muted' : 'live on'; liveEl.querySelector('span').textContent = micAsked ? 'Microfone desligado' : 'Ao vivo com o Waz'; return; }
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
    outCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_RATE });
    if (outCtx.state !== 'running') outCtx.resume().catch(function () {});
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
      // O microfone só é pedido quando o Waz termina a abertura (momento em que a pessoa quer responder).
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
      if (sc.inputTranscription && sc.inputTranscription.text) { curIn += sc.inputTranscription.text; userAnswered = true; spokeSinceOptions = true; }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        if (curIn) { push('cliente', curIn); curIn = ''; }
        curOut += fixName(sc.outputTranscription.text); feedCaption(sc.outputTranscription.text);
      }
      (sc.modelTurn && sc.modelTurn.parts || []).forEach(function (p) { if (p.inlineData && p.inlineData.data) playChunk(p.inlineData.data); });
      if (sc.modelTurn) waitingReply = 0;
      if (sc.turnComplete) {
        if (curOut) { push('waz', curOut); curOut = ''; } capLastT = 0;
        if (transcript.length % 4 === 0) track('transcricao', { transcricao: transcript }); // salva a transcrição parcial (abandonos)
        if (!micAsked) { micAsked = true; askMicAfterOpening(); }
      }
    }
    if (msg.toolCall && msg.toolCall.functionCalls) {
      msg.toolCall.functionCalls.forEach(function (fc) {
        (window.__wazLog = window.__wazLog || []).push(fc.name + ' ' + JSON.stringify(fc.args));
        if (fc.name === 'mostrar_visual') { track('visual', { id: fc.args && fc.args.id }); showVisual(fc.args && fc.args.id); }
        else if (fc.name === 'perguntar_opcoes') showOptions(fc.args || {});
        else if (fc.name === 'confirmar_dados') showConfirm(fc.args || {});
        else if (fc.name === 'registrar_contexto') { var a = fc.args || {}; leadData.empresa = a.empresa || leadData.empresa; leadData.nome = a.nome || leadData.nome; if (a.whatsapp) leadData.whatsapp = String(a.whatsapp).replace(/\D/g, ''); if (a.email) leadData.email = a.email; track('contexto', a); }
        else if (fc.name === 'registrar_lead') sendLead(fc.args || {});
        ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result: 'ok' } }] } }));
      });
    }
    if (msg.goAway && resumeHandle && !reconnecting) { try { ws.onclose = null; ws.close(); } catch (e) {} reconnect(); }
  }
  async function askMicAfterOpening() {
    // espera o áudio da abertura terminar de tocar, aí pede o microfone
    var wait = outCtx ? Math.max(0, (playHead - outCtx.currentTime) * 1000) + 150 : 0;
    setTimeout(async function () {
      if (!active) return;
      var ok = await ensureMic();
      if (ok) toggleLive(true);
      track('mic_permissao', { ok: ok });
      // se em alguns segundos ninguém respondeu, o Waz dá um empurrãozinho (uma vez só)
      nudgeTimer = setTimeout(function () {
        if (!active || userAnswered || !ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: ok
          ? 'O visitante ainda não respondeu. Diga, em uma frase curta e simpática, que pode falar normalmente ou digitar aqui embaixo.'
          : 'O visitante não liberou o microfone. Diga, em uma frase curta e simpática, que ele pode tocar no botão do microfone pra liberar e falar, ou digitar aqui embaixo.' }] }], turnComplete: true } }));
      }, 9000);
    }, wait);
  }
  function push(role, text) { transcript.push({ role: role, text: fixName(text) }); }

  var waitingReply = 0;
  function sendText(payload, shown) {
    if (!ws || ws.readyState !== 1) return;
    userAnswered = true; waitingReply = Date.now();
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

  function endCompactOff() { stage.classList.remove('compact'); }
  function end(fromServer) {
    endCompactOff();
    if (active) track('encerrado', { por: fromServer ? 'servidor' : 'usuario', duracao_seg: Math.floor((Date.now() - startedAt) / 1000), transcricao: transcript });
    active = false; liveMode = false; recording = false; connected = false; micBlocked = false; micAsked = false; userAnswered = false; if (nudgeTimer) clearTimeout(nudgeTimer);
    stopPlayback(); if (ws && ws.readyState <= 1) { try { ws.close(); } catch (e) {} } ws = null;
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    if (micCtx) { micCtx.close().catch(function () {}); micCtx = null; }
    if (outCtx) { outCtx.close().catch(function () {}); outCtx = null; }
    if (audioEl) { try { audioEl.pause(); audioEl.srcObject = null; } catch (e) {} }
    setLive(false, fromServer ? 'Conversa encerrada' : 'Encerrado');
    setCaption('Conversa encerrada. Obrigado pelo papo!', true);
    hideOptions(); showVisual('nenhum');
    setTimeout(function () { stage.classList.remove('on'); hero.classList.remove('hidden'); window.scrollTo(0, 0); }, 2500);
  }
  $('end').addEventListener('click', function () { end(false); });
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (!active) return;
    if (document.hidden) { hiddenAt = Date.now(); }
    else {
      if (outCtx && outCtx.state === 'suspended') outCtx.resume().catch(function () {});
      var fora = Date.now() - hiddenAt;
      if (ws && ws.readyState === 1 && hiddenAt && fora > 4000) {
        ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'O visitante saiu da tela por um momento e acabou de voltar. Dê boas-vindas de volta em uma frase curta e simpática ("opa, você voltou!") e retome exatamente de onde a conversa parou.' }] }], turnComplete: true } }));
      } else if ((!ws || ws.readyState > 1) && resumeHandle && !reconnecting) { reconnect(); }
      hiddenAt = 0;
    }
  });
  window.addEventListener('pagehide', function () { if (active) track('encerrado', { por: 'saiu', duracao_seg: Math.floor((Date.now() - startedAt) / 1000), transcricao: transcript }); });
  window.__wazDebug = { showVisual: showVisual, showConfirm: showConfirm, showOptions: showOptions, ctx: function () { return outCtx && { state: outCtx.state, t: outCtx.currentTime, playHead: playHead, words: capWords.length, lvl: outLevel() }; } };
  $('start').addEventListener('click', start);
})();
