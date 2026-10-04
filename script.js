import {
  collection,
  addDoc,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  deleteDoc,
  writeBatch,
  setDoc,
  onSnapshot,
  deleteField,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  waitForPendingWrites,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

// ZXing: fallback de leitura de código de barras para navegadores
// que não têm a API nativa BarcodeDetector (ex.: Safari no iPhone).
// Importado sob demanda (só quando o scanner é aberto num navegador sem
// BarcodeDetector) pra não pesar no carregamento inicial da página.
let _BrowserMultiFormatReader = null;
async function carregarZXing() {
  if (!_BrowserMultiFormatReader) {
    const mod = await import("https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm");
    _BrowserMultiFormatReader = mod.BrowserMultiFormatReader;
  }
  return _BrowserMultiFormatReader;
}

// ── Constantes ───────────────────────────────────────────────────
const LIMITE_ESTOQUE_BAIXO = 2;
const QUALIDADE_IMAGEM     = 0.7;
const TAMANHO_MAX_IMAGEM   = 400;

// Miniatura guardada dentro do documento do produto: é ela que aparece
// na lista (quadradinho de 52px). Pequena de propósito — o objetivo é que
// carregar a lista inteira seja leve.
const TAMANHO_MAX_THUMB    = 96;
const QUALIDADE_THUMB      = 0.55;

// Coleção separada com as fotos em tamanho grande, uma por produto.
// Só é lida quando alguém clica pra ampliar a foto.
const IMAGENS_COLLECTION   = "produtosImagens";

const SCANNER_INTERVALO_MS = 500;
const BARCODE_FORMATS      = ["ean_13","ean_8","code_128","code_39","qr_code","upc_a","upc_e"];

// Coleção de configurações gerais (locais de estoque, etc.)
const REPOS_COLLECTION = "config";

// Listas de reposição: um documento por lista (várias por loja)
const LISTAS_COLLECTION = "listasReposicao";

// Lojas que compartilham o mesmo depósito, mas têm listas de reposição separadas
const LOJAS = [
  { id: "orionth", nome: "Orion TH" },
  { id: "orion",   nome: "Orion" }
];
const LOJA_PADRAO   = "orionth";
const STORAGE_LOJA  = "lojaAtiva";   // guarda a loja ativa por dispositivo
const STORAGE_LISTA = "listaAtiva_"; // + id da loja: lista ativa por dispositivo

// ID do documento ANTIGO (uma lista só por loja) — usado só na migração
function docReposicaoLegadoId(lojaId) {
  return `listaReposicao_${lojaId}`;
}

// Nome de exibição da loja
function nomeLoja(lojaId) {
  const l = LOJAS.find(x => x.id === lojaId);
  return l ? l.nome : lojaId;
}

// ── Locais de estoque (gerenciáveis pelo app, salvos no Firestore) ──
// Documento: config/locaisEstoque = { locais: { "1": "Sheila", ... }, atualizadoEm: ts }
const LOCAIS_DOC_ID = "locaisEstoque";

// Locais iniciais — usados só na primeira vez, se o documento ainda não existir
const LOCAIS_PADRAO = {
  "1": "Sheila",
  "2": "Palanque",
  "3": "Restaurante",
  "4": "Salão"
};

// Locais atuais em memória (preenchido pelo listener do Firestore)
let ESTOQUES = { ...LOCAIS_PADRAO };

// Quantidade de cores disponíveis para as tags (ciclam quando passa disso)
const TOTAL_CORES_LOCAL = 10;

// Nome do local a partir do código guardado no produto ("" = sem local)
function nomeEstoque(codigo) {
  return ESTOQUES[String(codigo)] || "";
}

// Rótulo completo pra exibição: "2 · Palanque"
function rotuloEstoque(codigo) {
  const nome = nomeEstoque(codigo);
  return nome ? `${codigo} · ${nome}` : "";
}

// Classe de cor da tag, derivada do número do local (cicla a paleta)
function corEstoque(codigo) {
  const n = parseInt(codigo, 10);
  if (!n || n < 1) return "sem";
  return "c" + (((n - 1) % TOTAL_CORES_LOCAL) + 1);
}

// Números dos locais em ordem crescente
function codigosEstoqueOrdenados() {
  return Object.keys(ESTOQUES)
    .filter(k => ESTOQUES[k])
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

// Próximo número livre (maior existente + 1)
function proximoNumeroEstoque() {
  const nums = Object.keys(ESTOQUES).map(k => parseInt(k, 10)).filter(n => !isNaN(n));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// Quantos produtos estão guardados em determinado local
function contarProdutosNoLocal(codigo) {
  return estado.todosProdutos.filter(p => String(p.estoque || "") === String(codigo)).length;
}

// Limpa lixo do localStorage de versões anteriores
try { localStorage.removeItem("listaReposicao"); } catch {}

// ── Estado centralizado ──────────────────────────────────────────
const estado = {
  todosProdutos:    [],
  imagemThumb:      "",        // miniatura da foto escolhida no formulário
  imagemFull:       "",        // versão grande da foto escolhida no formulário
  imagemCarregando: false,
  // Cache em memória das fotos grandes já baixadas (evita reler o Firestore
  // toda vez que a mesma foto é ampliada): { [produtoId]: base64 }
  cacheImagens:     {},
  produtoAtual:     { id: null, nome: "", qtd: 0 },
  editarId:         null,
  termoBusca:       "",          // mantém o filtro ativo após alterações
  filtroEstoque:    "",          // "" = todos | "1".."4" = local | "sem" = sem local
  scannerBusca:     { stream: null, interval: null, ativo: false, zxingReader: null },
  scannerEditar:    { stream: null, interval: null, ativo: false, zxingReader: null },
  scannerAdd:       { stream: null, interval: null, ativo: false, zxingReader: null },
  // Listas abertas da loja ativa: [{ id, nome, numero, produtos, ordem, ... }]
  listas:           [],
  // Lista em que os produtos estão sendo marcados agora
  listaAtivaId:     null,
  // Listas criadas neste aparelho que ainda não voltaram no snapshot
  listasCriando:    {},
  migracaoListasFeita: false,
  // Foto escolhida no modal de editar
  editarFoto:       { thumb: "", full: "", alterada: false, remover: false, carregando: false },
  // Produtos da lista ATIVA (sincronizada via Firestore): { [produtoId]: quantidade }
  reposicao:        {},
  // Ordem de seleção dos produtos (na sequência em que foram marcados)
  ordemReposicao:   [],
  // Flag para distinguir limpeza/finalização LOCAL de REMOTA (outro dispositivo)
  finalizandoLocal: false,
  // Flag pra saber se o listener da reposição já foi iniciado
  listenerReposicaoAtivo: false,
  // Flag pra saber se o listener dos locais de estoque já foi iniciado
  listenerLocaisAtivo: false,
  // Loja ativa no momento (cada loja tem sua própria lista de reposição)
  lojaAtiva:        carregarLojaAtiva(),
  // Loja para a qual o listener atual está apontando
  lojaListener:     null,
  // Função para cancelar o listener atual (ao trocar de loja)
  unsubReposicao:   null
};

// Lê a loja ativa salva neste dispositivo (ou usa a padrão)
function carregarLojaAtiva() {
  try {
    const salva = localStorage.getItem(STORAGE_LOJA);
    if (salva && LOJAS.some(l => l.id === salva)) return salva;
  } catch {}
  return LOJA_PADRAO;
}

// ── Elementos do DOM ─────────────────────────────────────────────
const lista   = document.getElementById("listaProdutos");
const overlay = document.getElementById("loadingOverlay");
const toast   = document.getElementById("toast");

// ── UI Utilities ─────────────────────────────────────────────────
function showLoading(msg = "Carregando...") {
  document.getElementById("loadingMsg").textContent = msg;
  overlay.classList.add("ativo");
}

function hideLoading() {
  overlay.classList.remove("ativo");
}

function showToast(msg, emoji = "✅") {
  toast.textContent = `${emoji} ${msg}`;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2800);
}

function abrirModal(id) {
  document.getElementById(id).classList.add("ativo");
}

function fecharModal(id) {
  document.getElementById(id).classList.remove("ativo");
}

// ── Listas de Reposição: sincronização com Firestore ────────────
// Cada lista é um documento em listasReposicao/<id>:
//   { loja, nome, numero, produtos: {[id]: qtd}, ordem: [...], criadoEm, criadoEmLocal, atualizadoEm }
// Uma loja pode ter várias listas abertas ao mesmo tempo. A "lista ativa"
// é aquela em que os produtos são marcados (lembrada por dispositivo).

function carregarListaAtivaSalva(lojaId) {
  try { return localStorage.getItem(STORAGE_LISTA + lojaId) || null; } catch { return null; }
}

function salvarListaAtiva() {
  try {
    const chave = STORAGE_LISTA + estado.lojaAtiva;
    if (estado.listaAtivaId) localStorage.setItem(chave, estado.listaAtivaId);
    else localStorage.removeItem(chave);
  } catch {}
}

function listaAtiva() {
  return estado.listas.find(l => l.id === estado.listaAtivaId) || null;
}

function nomeListaAtiva() {
  const l = listaAtiva();
  return l ? l.nome : "Lista de Reposição";
}

// Referência do documento da lista ativa (null se não houver lista aberta)
function refReposicao() {
  return estado.listaAtivaId
    ? doc(window.db, LISTAS_COLLECTION, estado.listaAtivaId)
    : null;
}

// Copia os produtos da lista ativa para estado.reposicao / estado.ordemReposicao
function aplicarListaAtivaNoEstado() {
  const l = listaAtiva();
  estado.reposicao      = l ? { ...(l.produtos || {}) } : {};
  estado.ordemReposicao = l && Array.isArray(l.ordem) ? [...l.ordem] : [];
}

// "03/10 14:30"
function formatarDataCurta(d = new Date()) {
  return d.toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  }).replace(",", "");
}

// Escapa texto digitado pelo usuário antes de colocar no HTML
function escapeHtml(txt) {
  return String(txt ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Inicia (ou reinicia) o listener em tempo real das listas da loja ativa.
function iniciarListenerReposicao(forcar = false) {
  if (!forcar && estado.listenerReposicaoAtivo && estado.lojaListener === estado.lojaAtiva) {
    return;
  }

  // Cancela o listener anterior, se houver (ao trocar de loja)
  if (estado.unsubReposicao) {
    estado.unsubReposicao();
    estado.unsubReposicao = null;
  }
  estado.listenerReposicaoAtivo = true;
  const loja = estado.lojaAtiva;
  estado.lojaListener = loja;

  const q = query(collection(window.db, LISTAS_COLLECTION), where("loja", "==", loja));

  estado.unsubReposicao = onSnapshot(q, (snap) => {
    if (estado.lojaListener !== loja) return; // chegou atrasado de outra loja

    const listas = [];
    snap.forEach(d => listas.push({ id: d.id, ...d.data() }));

    // Listas recém-criadas neste aparelho que o snapshot ainda não trouxe
    for (const [id, dados] of Object.entries(estado.listasCriando)) {
      if (!listas.some(l => l.id === id)) listas.push({ id, ...dados });
    }

    listas.sort((a, b) =>
      (Number(a.numero) || 0) - (Number(b.numero) || 0) ||
      (Number(a.criadoEmLocal) || 0) - (Number(b.criadoEmLocal) || 0)
    );

    const idAnterior = estado.listaAtivaId;
    estado.listas = listas;

    // A lista ativa deixou de existir? (finalizada/excluída aqui ou em outro aparelho)
    const sumiu = !!idAnterior && !listas.some(l => l.id === idAnterior);

    if (!estado.listaAtivaId || sumiu) {
      const salva     = carregarListaAtivaSalva(loja);
      const escolhida = listas.find(l => l.id === salva && l.id !== idAnterior) || listas[0] || null;
      estado.listaAtivaId = escolhida ? escolhida.id : null;
      salvarListaAtiva();
    }

    aplicarListaAtivaNoEstado();
    renderizarSeletorListas();
    atualizarBannerReposicao();
    atualizarCheckboxesVisuais();

    const modal       = document.getElementById("modalReposicao");
    const modalAberto = modal && modal.classList.contains("ativo");

    if (sumiu) {
      const ehLocal = estado.finalizandoLocal;
      estado.finalizandoLocal = false;
      if (modalAberto) {
        fecharModal("modalReposicao");
        if (!ehLocal) showToast("Lista finalizada em outro dispositivo", "ℹ️");
      }
    } else if (modalAberto) {
      // Re-renderiza pra refletir mudanças vindas de outros dispositivos
      renderizarModalReposicao();
    }
  }, (err) => {
    console.error("Erro no listener das listas de reposição:", err);
  });
}

// Troca a loja ativa: salva, recria o listener e atualiza a interface
function trocarLoja(lojaId) {
  if (lojaId === estado.lojaAtiva) return;
  if (!LOJAS.some(l => l.id === lojaId)) return;

  estado.lojaAtiva = lojaId;
  try { localStorage.setItem(STORAGE_LOJA, lojaId); } catch {}

  // Zera o estado local (o listener da nova loja vai preencher)
  estado.listas        = [];
  estado.listaAtivaId  = null;
  estado.listasCriando = {};
  aplicarListaAtivaNoEstado();

  // Fecha o modal se estiver aberto (a lista mudou de contexto)
  fecharModal("modalReposicao");

  atualizarBotoesLoja();
  renderizarSeletorListas();
  atualizarBannerReposicao();
  atualizarCheckboxesVisuais();

  // Reinicia o listener apontando para as listas da nova loja
  iniciarListenerReposicao(true);

  showToast(`Listas da loja ${nomeLoja(lojaId)}`, "🏬");
}

// Atualiza o destaque visual dos botões de loja
function atualizarBotoesLoja() {
  document.querySelectorAll(".chip-loja").forEach(btn => {
    btn.classList.toggle("ativo", btn.dataset.loja === estado.lojaAtiva);
  });
  // Atualiza rótulos que mostram a loja ativa
  document.querySelectorAll(".loja-ativa-nome").forEach(el => {
    el.textContent = nomeLoja(estado.lojaAtiva);
  });
}

// ── Seletor de listas abertas ────────────────────────────────────
function renderizarSeletorListas() {
  const cont = document.getElementById("seletorListas");
  if (!cont) return;

  let html = "";
  if (estado.listas.length === 0) {
    html += `<span class="seletor-listas-label">📝 Nenhuma lista aberta — marque um produto ou crie uma nova</span>`;
  } else {
    html += `<span class="seletor-listas-label">📝 Marcando na lista:</span>`;
  }

  html += `<div class="seletor-listas-botoes">`;
  estado.listas.forEach(l => {
    const qtd   = Object.keys(l.produtos || {}).length;
    const ativo = l.id === estado.listaAtivaId;
    const dica  = ativo ? "Lista ativa — toque para abrir" : "Toque para marcar produtos nesta lista";
    html += `
      <button class="chip-lista${ativo ? " ativo" : ""}" data-lista="${l.id}" title="${dica}">
        <span class="chip-lista-nome">${escapeHtml(l.nome)}</span>
        <span class="chip-lista-qtd">${qtd}</span>
      </button>`;
  });
  html += `<button class="chip-lista chip-lista-nova" id="btnNovaLista" title="Começar outra lista para esta loja">➕ Nova lista</button>`;
  html += `</div>`;

  cont.innerHTML = html;

  cont.querySelectorAll(".chip-lista[data-lista]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.lista;
      if (id === estado.listaAtivaId) abrirModalReposicao();
      else selecionarLista(id);
    });
  });
  document.getElementById("btnNovaLista").addEventListener("click", () => criarNovaLista());
}

function selecionarLista(id) {
  const l = estado.listas.find(x => x.id === id);
  if (!l) return;
  estado.listaAtivaId = id;
  salvarListaAtiva();
  aplicarListaAtivaNoEstado();
  renderizarSeletorListas();
  atualizarBannerReposicao();
  atualizarCheckboxesVisuais();
  showToast(`Marcando em "${l.nome}"`, "📝");
}

// Cria uma lista nova para a loja ativa e já a deixa como ativa.
// Pode nascer com produtos (quando é criada ao marcar o 1º produto).
async function criarNovaLista(produtosIniciais = {}, ordemInicial = []) {
  const numero = estado.listas.reduce((m, l) => Math.max(m, Number(l.numero) || 0), 0) + 1;
  const ref    = doc(collection(window.db, LISTAS_COLLECTION));
  const nome   = `Lista ${numero} · ${formatarDataCurta()}`;
  const dados  = {
    loja:          estado.lojaAtiva,
    nome,
    numero,
    produtos:      produtosIniciais,
    ordem:         ordemInicial,
    criadoEmLocal: Date.now()
  };

  // Atualização otimista: a lista aparece na hora
  estado.listasCriando[ref.id] = dados;
  estado.listas = [...estado.listas, { id: ref.id, ...dados }];
  estado.listaAtivaId = ref.id;
  salvarListaAtiva();
  aplicarListaAtivaNoEstado();
  renderizarSeletorListas();
  atualizarBannerReposicao();
  atualizarCheckboxesVisuais();
  showToast(`${nome} criada`, "🆕");

  try {
    await setDoc(ref, {
      ...dados,
      criadoEm:     serverTimestamp(),
      atualizadoEm: serverTimestamp()
    });
    return ref.id;
  } catch (err) {
    // Desfaz
    estado.listas = estado.listas.filter(l => l.id !== ref.id);
    if (estado.listaAtivaId === ref.id) {
      estado.listaAtivaId = estado.listas[0] ? estado.listas[0].id : null;
      salvarListaAtiva();
    }
    aplicarListaAtivaNoEstado();
    renderizarSeletorListas();
    atualizarBannerReposicao();
    atualizarCheckboxesVisuais();
    showToast("Erro ao criar lista", "❌");
    console.error(err);
    return null;
  } finally {
    delete estado.listasCriando[ref.id];
  }
}

async function renomearListaAtiva() {
  const l = listaAtiva();
  if (!l) return;
  const novo = prompt("Nome da lista:", l.nome);
  if (novo === null) return;
  const limpo = novo.trim();
  if (!limpo || limpo === l.nome) return;

  try {
    await updateDoc(doc(window.db, LISTAS_COLLECTION, l.id), {
      nome: limpo,
      atualizadoEm: serverTimestamp()
    });
    showToast("Lista renomeada", "✏️");
  } catch (err) {
    showToast("Erro ao renomear lista", "❌");
    console.error(err);
  }
}

// Migração única: as versões antigas tinham UMA lista por loja em
// config/listaReposicao_<loja>. Se houver algo lá, vira a "Lista 1" da loja.
// O id fixo (antiga_<loja>) evita duplicar se dois aparelhos rodarem juntos.
async function migrarListasAntigas() {
  if (estado.migracaoListasFeita) return;
  estado.migracaoListasFeita = true;

  for (const loja of LOJAS) {
    try {
      const refAntiga = doc(window.db, REPOS_COLLECTION, docReposicaoLegadoId(loja.id));
      const snap = await getDoc(refAntiga);
      if (!snap.exists()) continue;

      const dados    = snap.data() || {};
      const produtos = dados.produtos || {};

      if (Object.keys(produtos).length > 0) {
        const batch = writeBatch(window.db);
        batch.set(doc(window.db, LISTAS_COLLECTION, `antiga_${loja.id}`), {
          loja:          loja.id,
          nome:          `Lista 1 · ${formatarDataCurta()}`,
          numero:        1,
          produtos,
          ordem:         Array.isArray(dados.ordem) ? dados.ordem : Object.keys(produtos),
          criadoEm:      serverTimestamp(),
          criadoEmLocal: Date.now(),
          atualizadoEm:  serverTimestamp()
        });
        batch.delete(refAntiga);
        await batch.commit();
      } else {
        await deleteDoc(refAntiga);
      }
    } catch (err) {
      console.error(`Erro ao migrar a lista antiga da loja ${loja.id}:`, err);
    }
  }
}

// ── Locais de estoque: sincronização com Firestore ───────────────
function refLocais() {
  return doc(window.db, REPOS_COLLECTION, LOCAIS_DOC_ID);
}

// Escuta os locais em tempo real; cria os padrões na primeira vez
function iniciarListenerLocais() {
  if (estado.listenerLocaisAtivo) return;
  estado.listenerLocaisAtivo = true;

  onSnapshot(refLocais(), async (snap) => {
    if (!snap.exists()) {
      // Primeira execução: grava os locais padrão
      try {
        await setDoc(refLocais(), {
          locais: LOCAIS_PADRAO,
          atualizadoEm: serverTimestamp()
        });
      } catch (err) {
        console.error("Erro ao criar locais padrão:", err);
      }
      return; // o próprio snapshot seguinte trará os dados
    }

    const dados = snap.data() || {};
    ESTOQUES = dados.locais || {};

    // Redesenha tudo que depende dos locais
    renderizarFiltrosEstoque();
    renderizarSelectsEstoque();
    renderizarGerenciarLocais();
    renderizarLista(produtosFiltrados());
  }, (err) => {
    console.error("Erro no listener dos locais:", err);
  });
}

// Cria um local novo com o próximo número livre
async function adicionarLocalEstoque(nome) {
  const limpo = (nome || "").trim();
  if (!limpo) {
    showToast("Digite o nome do local", "⚠️");
    return false;
  }

  // Evita nomes repetidos (ignorando maiúsculas/minúsculas)
  const jaExiste = Object.values(ESTOQUES).some(
    n => n.trim().toLowerCase() === limpo.toLowerCase()
  );
  if (jaExiste) {
    showToast(`"${limpo}" já existe`, "⚠️");
    return false;
  }

  const numero = String(proximoNumeroEstoque());
  try {
    await setDoc(refLocais(), {
      locais: { [numero]: limpo },
      atualizadoEm: serverTimestamp()
    }, { merge: true });
    showToast(`Local "${numero} · ${limpo}" criado`, "✅");
    return true;
  } catch (err) {
    showToast("Erro ao criar local", "❌");
    console.error(err);
    return false;
  }
}

// Renomeia um local existente (o número não muda)
async function renomearLocalEstoque(codigo, novoNome) {
  const limpo = (novoNome || "").trim();
  if (!limpo) {
    showToast("O nome não pode ficar vazio", "⚠️");
    return false;
  }
  if (limpo === ESTOQUES[String(codigo)]) return true; // nada mudou

  const jaExiste = Object.entries(ESTOQUES).some(
    ([k, n]) => k !== String(codigo) && n.trim().toLowerCase() === limpo.toLowerCase()
  );
  if (jaExiste) {
    showToast(`"${limpo}" já existe`, "⚠️");
    return false;
  }

  try {
    await setDoc(refLocais(), {
      locais: { [String(codigo)]: limpo },
      atualizadoEm: serverTimestamp()
    }, { merge: true });
    showToast(`Renomeado para "${limpo}"`, "✅");
    return true;
  } catch (err) {
    showToast("Erro ao renomear", "❌");
    console.error(err);
    return false;
  }
}

// Exclui um local — só permite se não houver produtos guardados nele
async function excluirLocalEstoque(codigo) {
  const nome  = nomeEstoque(codigo);
  const usados = contarProdutosNoLocal(codigo);

  if (usados > 0) {
    alert(
      `Não dá pra excluir "${codigo} · ${nome}".\n\n` +
      `${usados} produto(s) ainda estão guardados nesse local.\n\n` +
      `Mude esses produtos para outro local primeiro (use o filtro "${codigo} · ${nome}" na lista para achá-los).`
    );
    return false;
  }

  if (!confirm(`Excluir o local "${codigo} · ${nome}"?`)) return false;

  try {
    await setDoc(refLocais(), {
      locais: { [String(codigo)]: deleteField() },
      atualizadoEm: serverTimestamp()
    }, { merge: true });

    // Se o filtro ativo era esse local, volta pra "Todos"
    if (estado.filtroEstoque === String(codigo)) {
      estado.filtroEstoque = "";
    }
    showToast(`Local "${nome}" excluído`, "🗑️");
    return true;
  } catch (err) {
    showToast("Erro ao excluir local", "❌");
    console.error(err);
    return false;
  }
}

// Operações de escrita na lista ativa.
// updateDoc (e não setDoc com merge) de propósito: se a lista foi finalizada
// em outro aparelho, a escrita falha em vez de recriar uma lista fantasma.
async function setItemReposicao(produtoId, quantidade, listaId = estado.listaAtivaId) {
  if (!listaId) throw new Error("Nenhuma lista aberta");
  await updateDoc(doc(window.db, LISTAS_COLLECTION, listaId), {
    [`produtos.${produtoId}`]: quantidade,
    ordem: arrayUnion(produtoId),   // adiciona ao fim da ordem (sem duplicar)
    atualizadoEm: serverTimestamp()
  });
}

async function removerItemReposicao(produtoId, listaId = estado.listaAtivaId) {
  if (!listaId) throw new Error("Nenhuma lista aberta");
  await updateDoc(doc(window.db, LISTAS_COLLECTION, listaId), {
    [`produtos.${produtoId}`]: deleteField(),
    ordem: arrayRemove(produtoId),  // remove da ordem também
    atualizadoEm: serverTimestamp()
  });
}

// Retorna os IDs da lista de reposição na ordem em que foram selecionados.
// IDs sem posição registrada (dados antigos) vão para o fim.
function idsReposicaoOrdenados() {
  const ordem     = estado.ordemReposicao || [];
  const presentes = new Set(Object.keys(estado.reposicao));
  const resultado = [];

  for (const id of ordem) {
    if (presentes.has(id)) {
      resultado.push(id);
      presentes.delete(id);
    }
  }
  // Qualquer produto sem ordem registrada entra no fim
  for (const id of presentes) resultado.push(id);

  return resultado;
}

function totalProdutosReposicao() {
  return Object.keys(estado.reposicao).length;
}

function atualizarBannerReposicao() {
  const banner = document.getElementById("bannerReposicao");
  const sub    = document.getElementById("bannerReposicaoSub");
  const titulo = document.getElementById("bannerReposicaoTitulo");
  const total  = totalProdutosReposicao();

  if (titulo) titulo.textContent = `${nomeLoja(estado.lojaAtiva)} · ${nomeListaAtiva()}`;

  if (total === 0) {
    banner.style.display = "none";
  } else {
    banner.style.display = "block";
    const outras = estado.listas.length - 1;
    const txtOutras = outras > 0 ? ` · +${outras} lista${outras > 1 ? "s" : ""} aberta${outras > 1 ? "s" : ""}` : "";
    sub.textContent = (total === 1
      ? "1 produto para buscar"
      : `${total} produtos para buscar`) + txtOutras;
  }
}

async function toggleReposicao(produtoId, estoqueAtual) {
  if (estoqueAtual <= 0) {
    showToast("Produto sem estoque no depósito", "⚠️");
    return;
  }

  // Nenhuma lista aberta nesta loja: cria uma já com este produto
  if (!listaAtiva()) {
    await criarNovaLista({ [produtoId]: 1 }, [produtoId]);
    return;
  }

  const listaId = estado.listaAtivaId;
  const jaTem   = estado.reposicao[produtoId] !== undefined;

  // Atualização otimista local (UI responde rápido)
  if (jaTem) {
    delete estado.reposicao[produtoId];
    estado.ordemReposicao = estado.ordemReposicao.filter(x => x !== produtoId);
  } else {
    estado.reposicao[produtoId] = 1;
    // adiciona ao fim da ordem (se ainda não estiver lá)
    if (!estado.ordemReposicao.includes(produtoId)) {
      estado.ordemReposicao.push(produtoId);
    }
  }
  atualizarBannerReposicao();
  atualizarCheckboxesVisuais();

  // Persistir no Firestore (sincroniza com outros dispositivos)
  try {
    if (jaTem) {
      await removerItemReposicao(produtoId, listaId);
    } else {
      await setItemReposicao(produtoId, 1, listaId);
    }
  } catch (err) {
    // Reverter atualização otimista (só se ainda estivermos na mesma lista)
    if (estado.listaAtivaId === listaId) {
      if (jaTem) {
        estado.reposicao[produtoId] = 1;
        if (!estado.ordemReposicao.includes(produtoId)) {
          estado.ordemReposicao.push(produtoId);
        }
      } else {
        delete estado.reposicao[produtoId];
        estado.ordemReposicao = estado.ordemReposicao.filter(x => x !== produtoId);
      }
      atualizarBannerReposicao();
      atualizarCheckboxesVisuais();
    }
    showToast("Erro ao atualizar lista", "❌");
    console.error(err);
  }
}

function atualizarCheckboxesVisuais() {
  document.querySelectorAll(".produto-item").forEach(li => {
    const id = li.dataset.produtoId;
    const check = li.querySelector(".reposicao-check");
    if (!check) return;
    if (estado.reposicao[id] !== undefined) {
      check.classList.add("ativo");
      li.classList.add("produto-marcado");
    } else {
      check.classList.remove("ativo");
      li.classList.remove("produto-marcado");
    }
  });
}

// ── Upload de imagem ─────────────────────────────────────────────
const uploadArea = document.getElementById("uploadArea");
const fileInput  = document.getElementById("fileInput");
const preview    = document.getElementById("uploadPreview");

// Gera duas versões da foto a partir do arquivo escolhido:
//  - thumb: miniatura leve, guardada no documento do produto (usada na lista)
//  - full:  versão maior, guardada na coleção separada (usada ao ampliar)
function comprimirImagem(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const desenhar = (tamanhoMax, qualidade) => {
          const scale  = Math.min(1, tamanhoMax / img.width);
          const canvas = document.createElement("canvas");
          canvas.width  = Math.round(img.width  * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/jpeg", qualidade);
        };

        resolve({
          full:  desenhar(TAMANHO_MAX_IMAGEM, QUALIDADE_IMAGEM),
          thumb: desenhar(TAMANHO_MAX_THUMB,  QUALIDADE_THUMB)
        });
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// Gera só a miniatura a partir de uma imagem que já está em base64.
// Usada pela migração dos produtos antigos.
function gerarThumbDeBase64(base64) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = reject;
    img.onload = () => {
      const scale  = Math.min(1, TAMANHO_MAX_THUMB / img.width);
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", QUALIDADE_THUMB));
    };
    img.src = base64;
  });
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  estado.imagemCarregando = true;
  try {
    const { thumb, full } = await comprimirImagem(file);
    estado.imagemThumb = thumb;
    estado.imagemFull  = full;
    preview.src = thumb;
    uploadArea.classList.add("has-image");
  } catch {
    showToast("Erro ao processar imagem", "❌");
    estado.imagemThumb = "";
    estado.imagemFull  = "";
  } finally {
    estado.imagemCarregando = false;
  }
});

function resetUpload() {
  estado.imagemThumb      = "";
  estado.imagemFull       = "";
  estado.imagemCarregando = false;
  preview.src             = "";
  uploadArea.classList.remove("has-image");
  fileInput.value = "";
}

// ── Produtos ─────────────────────────────────────────────────────
async function mostrarProdutos() {
  showLoading("Buscando produtos...");

  try {
    const querySnapshot = await getDocs(collection(window.db, "produtos"));
    estado.todosProdutos = [];
    querySnapshot.forEach((documento) => {
      estado.todosProdutos.push({ id: documento.id, ...documento.data() });
    });

    // Converte a lista antiga (1 por loja) para o formato novo — só roda uma vez
    await migrarListasAntigas();

    // Inicia o listener das listas de reposição (uma única vez por sessão)
    iniciarListenerReposicao();
    iniciarListenerLocais();

    // Limpa das listas abertas qualquer produto que não existe mais OU que
    // está sem estoque, e ajusta quantidades maiores que o estoque atual.
    const ajustesReposicao = [];
    for (const lista of estado.listas) {
      const produtosLista = lista.produtos || {};
      for (const id of Object.keys(produtosLista)) {
        const prod = estado.todosProdutos.find(p => p.id === id);
        if (!prod || Number(prod.quantidade) <= 0) {
          ajustesReposicao.push({ listaId: lista.id, id, acao: "remover" });
        } else if (produtosLista[id] > Number(prod.quantidade)) {
          ajustesReposicao.push({ listaId: lista.id, id, acao: "ajustar", qtd: Number(prod.quantidade) });
        }
      }
    }

    // Propaga os ajustes pro Firestore (o listener atualiza a tela depois)
    for (const ajuste of ajustesReposicao) {
      try {
        if (ajuste.acao === "remover") {
          await removerItemReposicao(ajuste.id, ajuste.listaId);
        } else {
          await setItemReposicao(ajuste.id, ajuste.qtd, ajuste.listaId);
        }
      } catch (err) {
        console.error("Erro ao sincronizar ajuste da reposição:", err);
      }
    }

    // Reaplicar os filtros ativos (mantém busca e filtro de local após alterações)
    renderizarLista(produtosFiltrados());

    atualizarBannerReposicao();
  } catch (err) {
    showToast("Erro ao carregar produtos", "❌");
    console.error(err);
  } finally {
    hideLoading();
  }
}

function renderizarLista(produtos) {
  lista.innerHTML = "";

  let totalProdutos = 0;
  let totalItens    = 0;

  if (produtos.length === 0) {
    lista.innerHTML = `
      <div class="lista-vazia">
        <div class="lista-vazia-icon">📦</div>
        <p>Nenhum produto encontrado.</p>
      </div>`;
  }

  produtos.forEach((produto) => {
    const quantidade   = Number(produto.quantidade) || 0;
    // Usa a miniatura; se o produto ainda não foi migrado, cai na foto antiga.
    const imagem       = produto.thumb || produto.imagem || "https://placehold.co/52x52/1a1a24/8888aa?text=?";
    const estoqueClass = quantidade <= LIMITE_ESTOQUE_BAIXO ? "estoque-baixo" : "";
    const estoqueLabel = quantidade <= LIMITE_ESTOQUE_BAIXO ? `⚠️ ${quantidade}` : quantidade;
    const ariaEstoque  = quantidade <= LIMITE_ESTOQUE_BAIXO ? " (estoque baixo)" : "";

    const barcodeTag = produto.codigoBarras
      ? `<span class="barcode-tag" title="Código de barras">⬛ ${produto.codigoBarras}</span>`
      : "";

    const localTag = nomeEstoque(produto.estoque)
      ? `<span class="estoque-tag estoque-tag-${corEstoque(produto.estoque)}" title="Local no estoque">📍 ${rotuloEstoque(produto.estoque)}</span>`
      : "";

    const marcado     = estado.reposicao[produto.id] !== undefined;
    const checkAtivo  = marcado ? "ativo" : "";
    const liMarcado   = marcado ? "produto-marcado" : "";
    const semEstoque  = quantidade <= 0;
    const checkDisabled = semEstoque ? "disabled" : "";

    const li = document.createElement("li");
    li.className = `produto-item ${liMarcado}`;
    li.dataset.produtoId = produto.id;
    li.innerHTML = `
      <button class="reposicao-check ${checkAtivo}" title="Adicionar à lista de reposição"
              aria-label="Marcar ${produto.nome} para reposição" ${checkDisabled}>
        <span class="reposicao-check-icone">✓</span>
      </button>
      <img src="${imagem}" class="img-produto"
           alt="Foto de ${produto.nome}"
           title="Clique para ampliar"
           loading="lazy" decoding="async"
           onerror="this.src='https://placehold.co/52x52/1a1a24/8888aa?text=?'">
      <div class="produto-info">
        <span class="nome-produto">${produto.nome}</span>
        <span class="quantidade-produto ${estoqueClass}"
              aria-label="Quantidade: ${quantidade}${ariaEstoque}">
          Quantidade: ${estoqueLabel}
        </span>
        <span class="produto-tags">${barcodeTag}${localTag}</span>
      </div>
      <div class="acoes">
        <button class="btn-acao btn-mais"      title="Adicionar 1"        aria-label="Adicionar 1 unidade de ${produto.nome}">+</button>
        <button class="btn-acao btn-menos"     title="Remover 1"          aria-label="Remover 1 unidade de ${produto.nome}">−</button>
        <button class="btn-acao btn-minus-qtd" title="Ajustar quantidade" aria-label="Ajustar quantidade de ${produto.nome}">−N</button>
        <button class="btn-acao btn-editar"    title="Editar produto"     aria-label="Editar ${produto.nome}">✏️</button>
        <button class="btn-acao btn-remover"   title="Excluir produto"    aria-label="Excluir ${produto.nome}">🗑</button>
      </div>
    `;

    li.querySelector(".reposicao-check").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleReposicao(produto.id, quantidade);
    });
    li.querySelector(".img-produto").addEventListener("click", () => abrirModalFoto(produto.id, imagem));
    li.querySelector(".btn-mais").addEventListener("click", () => aumentar(produto.id, quantidade));
    li.querySelector(".btn-menos").addEventListener("click", () => diminuir(produto.id, quantidade));
    li.querySelector(".btn-minus-qtd").addEventListener("click", () =>
      abrirModalRemoverQtd(produto.id, produto.nome, quantidade)
    );
    li.querySelector(".btn-editar").addEventListener("click", () =>
      abrirModalEditar(produto)
    );
    li.querySelector(".btn-remover").addEventListener("click", () =>
      confirmarRemover(produto.id, produto.nome)
    );

    lista.appendChild(li);
    totalProdutos++;
    totalItens += quantidade;
  });

  document.getElementById("totalProdutos").textContent = totalProdutos;
  document.getElementById("totalItens").textContent    = totalItens;
}

window.mostrarProdutos = mostrarProdutos;

// Aplica os dois filtros (busca + local de estoque) sobre a lista completa
function produtosFiltrados() {
  const termo  = estado.termoBusca;
  const filtro = estado.filtroEstoque;

  return estado.todosProdutos.filter(p => {
    // Filtro por local de estoque
    if (filtro === "sem") {
      if (nomeEstoque(p.estoque)) return false;
    } else if (filtro) {
      if (String(p.estoque || "") !== filtro) return false;
    }

    // Filtro por termo de busca (nome ou código de barras)
    if (termo) {
      const casaNome    = p.nome.toLowerCase().includes(termo);
      const casaCodigo  = p.codigoBarras && p.codigoBarras.includes(termo);
      if (!casaNome && !casaCodigo) return false;
    }

    return true;
  });
}

window.filtrarProdutos = function () {
  estado.termoBusca = document.getElementById("campoBusca").value.trim().toLowerCase();
  renderizarLista(produtosFiltrados());
};

// Troca o filtro de local ativo e re-renderiza
function aplicarFiltroEstoque(valor) {
  estado.filtroEstoque = valor;

  document.querySelectorAll(".chip-estoque").forEach(chip => {
    chip.classList.toggle("ativo", chip.dataset.estoque === valor);
  });

  renderizarLista(produtosFiltrados());
}

// ── Renderização dinâmica dos locais ─────────────────────────────

// Botões de filtro por local (Todos + cada local + Sem local)
function renderizarFiltrosEstoque() {
  const cont = document.getElementById("filtrosEstoque");
  if (!cont) return;

  const codigos = codigosEstoqueOrdenados();

  // Se o filtro ativo apontava para um local que não existe mais, volta pra "Todos"
  if (estado.filtroEstoque && estado.filtroEstoque !== "sem"
      && !codigos.includes(estado.filtroEstoque)) {
    estado.filtroEstoque = "";
  }

  let html = `<button class="chip-estoque${estado.filtroEstoque === "" ? " ativo" : ""}" data-estoque="">Todos</button>`;

  codigos.forEach(cod => {
    const ativo = estado.filtroEstoque === cod ? " ativo" : "";
    html += `<button class="chip-estoque${ativo}" data-estoque="${cod}">${cod} · ${ESTOQUES[cod]}</button>`;
  });

  html += `<button class="chip-estoque${estado.filtroEstoque === "sem" ? " ativo" : ""}" data-estoque="sem">Sem local</button>`;
  html += `<button class="chip-estoque chip-gerenciar" id="btnGerenciarLocais" title="Adicionar ou editar locais">⚙️ Locais</button>`;

  cont.innerHTML = html;

  // Religa os eventos (o innerHTML apagou os antigos)
  cont.querySelectorAll(".chip-estoque:not(.chip-gerenciar)").forEach(chip => {
    chip.addEventListener("click", () => aplicarFiltroEstoque(chip.dataset.estoque));
  });
  const btnGer = document.getElementById("btnGerenciarLocais");
  if (btnGer) btnGer.addEventListener("click", abrirModalLocais);
}

// Opções dos <select> de local (formulário de novo produto e modal de editar)
function renderizarSelectsEstoque() {
  const codigos = codigosEstoqueOrdenados();

  const configs = [
    { id: "estoqueProduto",    placeholder: "📍 Local no estoque (opcional)" },
    { id: "inputEditarEstoque", placeholder: "📍 Sem local definido" }
  ];

  configs.forEach(({ id, placeholder }) => {
    const sel = document.getElementById(id);
    if (!sel) return;

    const valorAtual = sel.value; // preserva a seleção durante o redesenho

    let html = `<option value="">${placeholder}</option>`;
    codigos.forEach(cod => {
      html += `<option value="${cod}">${cod} · ${ESTOQUES[cod]}</option>`;
    });
    sel.innerHTML = html;

    // Restaura a seleção se o local ainda existir
    sel.value = codigos.includes(valorAtual) ? valorAtual : "";
  });
}

// ── Modal: Gerenciar locais ──────────────────────────────────────
function abrirModalLocais() {
  renderizarGerenciarLocais();
  const input = document.getElementById("inputNovoLocal");
  if (input) input.value = "";
  abrirModal("modalLocais");
}

function renderizarGerenciarLocais() {
  const cont = document.getElementById("listaLocais");
  if (!cont) return;

  const codigos = codigosEstoqueOrdenados();
  cont.innerHTML = "";

  if (codigos.length === 0) {
    cont.innerHTML = `<p class="locais-vazio">Nenhum local cadastrado ainda. Crie o primeiro abaixo. 👇</p>`;
  }

  codigos.forEach(cod => {
    const usados = contarProdutosNoLocal(cod);
    const linha = document.createElement("div");
    linha.className = "item-local";
    linha.innerHTML = `
      <span class="item-local-num estoque-tag estoque-tag-${corEstoque(cod)}">${cod}</span>
      <input type="text" class="item-local-nome" value="${ESTOQUES[cod].replace(/"/g, "&quot;")}"
             aria-label="Nome do local ${cod}">
      <span class="item-local-uso" title="Produtos guardados aqui">${usados}</span>
      <button class="item-local-btn item-local-salvar" title="Salvar nome">✓</button>
      <button class="item-local-btn item-local-excluir" title="Excluir local">🗑</button>
    `;

    const input = linha.querySelector(".item-local-nome");

    linha.querySelector(".item-local-salvar").addEventListener("click", async () => {
      await renomearLocalEstoque(cod, input.value);
    });

    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        await renomearLocalEstoque(cod, input.value);
        input.blur();
      }
    });

    linha.querySelector(".item-local-excluir").addEventListener("click", async () => {
      await excluirLocalEstoque(cod);
    });

    cont.appendChild(linha);
  });

  // Dica do próximo número
  const dica = document.getElementById("proximoNumeroLocal");
  if (dica) dica.textContent = proximoNumeroEstoque();
}

async function criarLocalPeloModal() {
  const input = document.getElementById("inputNovoLocal");
  if (!input) return;

  const btn = document.getElementById("btnCriarLocal");
  btn.disabled = true;

  const ok = await adicionarLocalEstoque(input.value);
  if (ok) input.value = "";

  btn.disabled = false;
  input.focus();
}

window.adicionarProduto = async function () {
  const nome         = document.getElementById("nomeProduto").value.trim();
  const quantidade   = parseInt(document.getElementById("quantidadeProduto").value);
  const codigoBarras = document.getElementById("codigoBarrasProduto").value.trim();
  const estoqueLocal = document.getElementById("estoqueProduto").value;
  const btn          = document.getElementById("btnAdicionar");
  const spinner      = document.getElementById("btnSpinner");
  const btnText      = document.getElementById("btnText");

  if (!nome || isNaN(quantidade) || quantidade < 1) {
    showToast("Preencha o nome e a quantidade corretamente", "⚠️");
    return;
  }

  if (estado.imagemCarregando) {
    showToast("Aguarde a imagem terminar de carregar", "⏳");
    return;
  }

  const duplicado = estado.todosProdutos.find(
    p => p.nome.toLowerCase() === nome.toLowerCase()
  );
  if (duplicado) {
    showToast(`"${nome}" já existe no estoque`, "⚠️");
    return;
  }

  if (codigoBarras) {
    const dupCodigo = estado.todosProdutos.find(
      p => p.codigoBarras && p.codigoBarras === codigoBarras
    );
    if (dupCodigo) {
      showToast(`Código de barras já cadastrado em "${dupCodigo.nome}"`, "⚠️");
      return;
    }
  }

  btn.disabled = true;
  spinner.classList.add("ativo");
  btnText.textContent = "Adicionando...";

  try {
    // O documento do produto guarda só a miniatura (leve, usada na lista).
    const ref = await addDoc(collection(window.db, "produtos"), {
      nome,
      quantidade,
      thumb: estado.imagemThumb || "",
      codigoBarras: codigoBarras || "",
      estoque: estoqueLocal || ""
    });

    // A foto em tamanho grande vai pra coleção separada, com o mesmo id.
    // Se falhar, o produto continua cadastrado — só fica sem a foto ampliada.
    if (estado.imagemFull) {
      try {
        await setDoc(doc(window.db, IMAGENS_COLLECTION, ref.id), {
          imagem: estado.imagemFull,
          atualizadoEm: serverTimestamp()
        });
      } catch (e) {
        console.error("Erro ao salvar a foto ampliada:", e);
        showToast("Produto salvo, mas a foto grande falhou", "⚠️");
      }
    }

    document.getElementById("nomeProduto").value         = "";
    document.getElementById("quantidadeProduto").value   = "";
    document.getElementById("codigoBarrasProduto").value = "";
    document.getElementById("estoqueProduto").value      = "";
    pararScannerGenerico(estado.scannerAdd, "scannerAreaAdd", "btnScanAdd");
    resetUpload();
    showToast(`"${nome}" adicionado ao estoque!`);
    await mostrarProdutos();
  } catch (err) {
    showToast("Erro ao adicionar produto", "❌");
    console.error(err);
  } finally {
    btn.disabled = false;
    spinner.classList.remove("ativo");
    btnText.textContent = "Adicionar Produto";
  }
};

// ── Quantidade ───────────────────────────────────────────────────
async function aumentar(id, quantidade) {
  showLoading("Atualizando...");
  try {
    await updateDoc(doc(window.db, "produtos", id), { quantidade: quantidade + 1 });
    await mostrarProdutos();
  } catch (err) {
    showToast("Erro ao atualizar", "❌");
    hideLoading();
  }
}

async function diminuir(id, quantidade) {
  if (quantidade <= 0) { showToast("Quantidade já é zero", "⚠️"); return; }
  showLoading("Atualizando...");
  try {
    await updateDoc(doc(window.db, "produtos", id), { quantidade: quantidade - 1 });
    await mostrarProdutos();
  } catch (err) {
    showToast("Erro ao atualizar", "❌");
    hideLoading();
  }
}

function abrirModalRemoverQtd(id, nome, qtdAtual) {
  estado.produtoAtual = { id, nome, qtd: qtdAtual };
  document.getElementById("modalRemoverAtual").textContent = qtdAtual;
  document.getElementById("inputRemoverQtd").value = "";
  abrirModal("modalRemoverQtd");
}

window.fecharModalRemoverQtd = function () {
  fecharModal("modalRemoverQtd");
};

async function confirmarAjusteQtd(tipo) {
  const qtd = parseInt(document.getElementById("inputRemoverQtd").value);

  if (isNaN(qtd) || qtd < 1) {
    showToast("Digite uma quantidade válida", "⚠️");
    return;
  }

  if (tipo === "rem" && qtd > estado.produtoAtual.qtd) {
    showToast(`Estoque atual é só ${estado.produtoAtual.qtd}`, "⚠️");
    return;
  }

  const isAdd   = tipo === "add";
  const btnEl   = document.getElementById(isAdd ? "btnAjusteAdd" : "btnAjusteRem");
  const spinner = document.getElementById(isAdd ? "spinnerAjusteAdd" : "spinnerAjusteRem");
  const texto   = document.getElementById(isAdd ? "textoAjusteAdd" : "textoAjusteRem");

  btnEl.disabled = true;
  spinner.classList.add("ativo");
  texto.textContent = isAdd ? "Adicionando..." : "Removendo...";

  const novaQtd = isAdd
    ? estado.produtoAtual.qtd + qtd
    : estado.produtoAtual.qtd - qtd;

  try {
    await updateDoc(doc(window.db, "produtos", estado.produtoAtual.id), { quantidade: novaQtd });
    fecharModal("modalRemoverQtd");
    showToast(
      isAdd
        ? `+${qtd} adicionado(s) a "${estado.produtoAtual.nome}"`
        : `−${qtd} removido(s) de "${estado.produtoAtual.nome}"`
    );
    await mostrarProdutos();
  } catch (err) {
    showToast("Erro ao atualizar", "❌");
    console.error(err);
  } finally {
    btnEl.disabled = false;
    spinner.classList.remove("ativo");
    texto.textContent = isAdd ? "➕ Adicionar" : "➖ Remover";
  }
}

// ── Editar produto ────────────────────────────────────────────────
function abrirModalEditar(produto) {
  estado.editarId = produto.id;
  document.getElementById("inputEditarNome").value    = produto.nome;
  document.getElementById("inputEditarBarcode").value = produto.codigoBarras || "";
  document.getElementById("inputEditarEstoque").value = produto.estoque || "";

  // Foto atual (miniatura) — pode ser trocada ou removida
  estado.editarFoto = { thumb: "", full: "", alterada: false, remover: false, carregando: false };
  document.getElementById("inputEditarFoto").value = "";
  mostrarFotoEditar(produto.thumb || produto.imagem || "", "");

  pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");
  abrirModal("modalEditar");
  setTimeout(() => document.getElementById("inputEditarNome").focus(), 100);
}

// Mostra a foto no quadrado do modal de editar ("" = sem foto)
function mostrarFotoEditar(src, status) {
  const box    = document.getElementById("editarFotoThumb");
  const input  = document.getElementById("inputEditarFoto");
  const btnRem = document.getElementById("btnRemoverFoto");

  // Remove a imagem/placeholder anterior, mantendo o <input type=file>
  box.querySelectorAll("img, .editar-foto-vazia").forEach(el => el.remove());

  if (src) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "Foto do produto";
    box.insertBefore(img, input);
  } else {
    const vazio = document.createElement("span");
    vazio.className = "editar-foto-vazia";
    vazio.innerHTML = "🖼️<br>Sem foto";
    box.insertBefore(vazio, input);
  }

  btnRem.style.display = src ? "" : "none";
  document.getElementById("editarFotoStatus").textContent = status || "";
}

async function escolherFotoEditar(e) {
  const file = e.target.files[0];
  if (!file) return;

  estado.editarFoto.carregando = true;
  document.getElementById("editarFotoStatus").textContent = "Processando...";
  try {
    const { thumb, full } = await comprimirImagem(file);
    estado.editarFoto = { thumb, full, alterada: true, remover: false, carregando: false };
    mostrarFotoEditar(thumb, "Nova foto — clique em Salvar");
  } catch (err) {
    estado.editarFoto.carregando = false;
    document.getElementById("editarFotoStatus").textContent = "";
    showToast("Erro ao processar imagem", "❌");
    console.error(err);
  }
}

function removerFotoEditar() {
  estado.editarFoto = { thumb: "", full: "", alterada: false, remover: true, carregando: false };
  document.getElementById("inputEditarFoto").value = "";
  mostrarFotoEditar("", "Foto será removida ao salvar");
}

window.fecharModalEditar = function () {
  pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");
  fecharModal("modalEditar");
};

window.salvarEdicao = async function () {
  const novoNome    = document.getElementById("inputEditarNome").value.trim();
  const novoBarcode = document.getElementById("inputEditarBarcode").value.trim();
  const novoEstoque = document.getElementById("inputEditarEstoque").value;

  if (!novoNome) { showToast("Digite um nome válido", "⚠️"); return; }

  if (estado.editarFoto.carregando) {
    showToast("Aguarde a imagem terminar de carregar", "⏳");
    return;
  }

  const btn     = document.querySelector("#modalEditar .btn-modal-confirm");
  const spinner = document.getElementById("spinnerEditar");
  const texto   = document.getElementById("textoSalvar");

  btn.disabled = true;
  spinner.classList.add("ativo");
  texto.textContent = "Salvando...";

  pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");

  const id   = estado.editarId;
  const foto = estado.editarFoto;

  try {
    const dados = {
      nome: novoNome,
      codigoBarras: novoBarcode,
      estoque: novoEstoque || ""
    };
    if (foto.alterada || foto.remover) {
      dados.thumb  = foto.alterada ? foto.thumb : "";
      dados.imagem = deleteField(); // apaga a foto do formato antigo, se ainda existir
    }
    await updateDoc(doc(window.db, "produtos", id), dados);

    // Foto grande na coleção separada (mesmo id do produto)
    if (foto.alterada) {
      try {
        await setDoc(doc(window.db, IMAGENS_COLLECTION, id), {
          imagem: foto.full,
          atualizadoEm: serverTimestamp()
        });
        estado.cacheImagens[id] = foto.full;
      } catch (e) {
        delete estado.cacheImagens[id];
        console.error("Erro ao salvar a foto ampliada:", e);
        showToast("Produto salvo, mas a foto grande falhou", "⚠️");
      }
    } else if (foto.remover) {
      try {
        await deleteDoc(doc(window.db, IMAGENS_COLLECTION, id));
      } catch (e) {
        console.error("Erro ao apagar a foto ampliada:", e);
      }
      delete estado.cacheImagens[id];
    }

    fecharModal("modalEditar");
    showToast(`"${novoNome}" atualizado!`);
    await mostrarProdutos();
  } catch (err) {
    showToast("Erro ao salvar", "❌");
    console.error(err);
  } finally {
    btn.disabled = false;
    spinner.classList.remove("ativo");
    texto.textContent = "Salvar";
  }
};

document.getElementById("inputEditarNome").addEventListener("keydown", (e) => {
  if (e.key === "Enter") window.salvarEdicao();
});
document.getElementById("inputEditarBarcode").addEventListener("keydown", (e) => {
  if (e.key === "Enter") window.salvarEdicao();
});

// ── Modal Foto ────────────────────────────────────────────────────
// Mostra a miniatura na hora (resposta instantânea) e, em paralelo, busca a
// foto em tamanho grande na coleção separada, trocando quando ela chegar.
async function abrirModalFoto(produtoId, thumbSrc) {
  if (!thumbSrc || thumbSrc.includes("placehold.co")) return;

  const img = document.getElementById("modalFotoImg");
  img.src = thumbSrc;          // aparece imediatamente, mesmo que borrada
  abrirModal("modalFoto");

  if (!produtoId) return;

  // Já baixamos essa foto antes nesta sessão?
  if (estado.cacheImagens[produtoId]) {
    img.src = estado.cacheImagens[produtoId];
    return;
  }

  try {
    const snap = await getDoc(doc(window.db, IMAGENS_COLLECTION, produtoId));
    if (snap.exists() && snap.data().imagem) {
      const grande = snap.data().imagem;
      estado.cacheImagens[produtoId] = grande;

      // Só troca se o modal ainda estiver mostrando esta mesma foto
      // (o usuário pode ter fechado e aberto outra enquanto carregava).
      const modal = document.getElementById("modalFoto");
      if (modal && modal.classList.contains("ativo")) {
        img.src = grande;
      }
    }
  } catch (err) {
    // Sem foto grande disponível — a miniatura continua na tela.
    console.error("Erro ao carregar foto ampliada:", err);
  }
}

window.fecharModalFoto = function () {
  fecharModal("modalFoto");
};

// ── Remover produto ───────────────────────────────────────────────
function confirmarRemover(id, nome) {
  if (confirm(`Excluir "${nome}" do estoque?`)) remover(id, nome);
}

async function remover(id, nome) {
  showLoading("Removendo produto...");
  try {
    await deleteDoc(doc(window.db, "produtos", id));

    // Apaga também a foto grande da coleção separada (senão fica lixo no banco)
    try {
      await deleteDoc(doc(window.db, IMAGENS_COLLECTION, id));
    } catch (e) {
      console.error("Erro ao apagar a foto ampliada:", e);
    }
    delete estado.cacheImagens[id];

    // Remove o produto de TODAS as listas abertas, de todas as lojas
    // (senão ficaria um item fantasma em outra lista)
    try {
      const listasSnap = await getDocs(collection(window.db, LISTAS_COLLECTION));
      for (const d of listasSnap.docs) {
        const prods = d.data().produtos || {};
        if (prods[id] === undefined) continue;
        try {
          await removerItemReposicao(id, d.id);
        } catch (e) { console.error(`Erro ao limpar produto da lista ${d.id}:`, e); }
      }
    } catch (e) { console.error("Erro ao buscar listas de reposição:", e); }

    // Atualiza o estado local da loja ativa
    if (estado.reposicao[id] !== undefined) {
      delete estado.reposicao[id];
      estado.ordemReposicao = estado.ordemReposicao.filter(x => x !== id);
    }

    showToast(`"${nome}" removido`, "🗑️");
    await mostrarProdutos();
  } catch (err) {
    showToast("Erro ao remover", "❌");
    hideLoading();
  }
}

// ── Modal de Reposição ────────────────────────────────────────────
function abrirModalReposicao() {
  if (!listaAtiva()) {
    showToast("Nenhuma lista aberta nesta loja", "⚠️");
    return;
  }
  renderizarModalReposicao();
  abrirModal("modalReposicao");
}

function renderizarModalReposicao() {
  const container = document.getElementById("listaReposicao");
  const info      = document.getElementById("reposicaoInfo");
  const total     = totalProdutosReposicao();

  const totalTxt = total === 1
    ? "1 produto para buscar no depósito"
    : `${total} produtos para buscar no depósito`;
  info.innerHTML = `<span class="reposicao-loja-badge">🏬 ${nomeLoja(estado.lojaAtiva)}</span> ${totalTxt}`;
  document.getElementById("tituloListaModal").textContent = nomeListaAtiva();

  container.innerHTML = "";

  if (total === 0) {
    container.innerHTML = `
      <div class="lista-vazia">
        <div class="lista-vazia-icon">📝</div>
        <p>Lista vazia. Marque produtos na lista do estoque para adicioná-los aqui.</p>
      </div>`;
    return;
  }

  // Segue a ordem em que os produtos foram selecionados
  const itens = idsReposicaoOrdenados()
    .map(id => estado.todosProdutos.find(p => p.id === id))
    .filter(p => p);

  itens.forEach((produto, index) => {
    const estoque    = Number(produto.quantidade) || 0;
    const aLevar     = estado.reposicao[produto.id];
    const imagem     = produto.thumb || produto.imagem || "https://placehold.co/40x40/1a1a24/8888aa?text=?";
    const barcode    = produto.codigoBarras ? `⬛ ${produto.codigoBarras}` : "(sem código)";
    const estoqueBx  = estoque <= LIMITE_ESTOQUE_BAIXO;
    const estoqueLbl = estoqueBx ? `⚠️ ${estoque} un` : `${estoque} un`;
    const estoqueCss = estoqueBx ? "estoque-baixo" : "";

    const localTag = nomeEstoque(produto.estoque)
      ? `<span class="estoque-tag estoque-tag-${corEstoque(produto.estoque)}">📍 ${rotuloEstoque(produto.estoque)}</span>`
      : `<span class="estoque-tag estoque-tag-sem">📍 sem local</span>`;

    const div = document.createElement("div");
    div.className = "item-reposicao";
    div.innerHTML = `
      <div class="item-reposicao-topo">
        <span class="item-reposicao-num">${index + 1}.</span>
        <img src="${imagem}" class="item-reposicao-img"
             onerror="this.src='https://placehold.co/40x40/1a1a24/8888aa?text=?'"
             alt="${produto.nome}">
        <div class="item-reposicao-info">
          <div class="item-reposicao-nome">${produto.nome}</div>
          <div class="item-reposicao-codigo">${barcode}</div>
          <div class="item-reposicao-local">${localTag}</div>
        </div>
        <button class="item-reposicao-remover" title="Remover da lista"
                aria-label="Remover ${produto.nome} da lista">✕</button>
      </div>
      <div class="item-reposicao-controles">
        <div class="item-reposicao-estoque ${estoqueCss}">
          Estoque: <strong>${estoqueLbl}</strong>
        </div>
        <div class="item-reposicao-levar">
          <span class="levar-label">Levar:</span>
          <button class="btn-qtd btn-qtd-menos" aria-label="Diminuir">−</button>
          <span class="qtd-valor">${aLevar}</span>
          <button class="btn-qtd btn-qtd-mais" aria-label="Aumentar">+</button>
        </div>
      </div>
    `;

    div.querySelector(".item-reposicao-remover").addEventListener("click", async () => {
      // Atualização otimista
      const qtdAnterior   = estado.reposicao[produto.id];
      const ordemAnterior = [...estado.ordemReposicao];
      delete estado.reposicao[produto.id];
      estado.ordemReposicao = estado.ordemReposicao.filter(x => x !== produto.id);
      atualizarBannerReposicao();
      atualizarCheckboxesVisuais();

      renderizarModalReposicao();

      try {
        await removerItemReposicao(produto.id);
      } catch (err) {
        // Reverte em caso de erro
        estado.reposicao[produto.id] = qtdAnterior;
        estado.ordemReposicao = ordemAnterior;
        atualizarBannerReposicao();
        atualizarCheckboxesVisuais();
        showToast("Erro ao remover item", "❌");
        console.error(err);
      }
    });

    div.querySelector(".btn-qtd-menos").addEventListener("click", async () => {
      if (estado.reposicao[produto.id] > 1) {
        const novaQtd = estado.reposicao[produto.id] - 1;
        estado.reposicao[produto.id] = novaQtd;
        renderizarModalReposicao();
        try {
          await setItemReposicao(produto.id, novaQtd);
        } catch (err) {
          estado.reposicao[produto.id] = novaQtd + 1; // reverte
          renderizarModalReposicao();
          showToast("Erro ao atualizar", "❌");
          console.error(err);
        }
      }
    });

    div.querySelector(".btn-qtd-mais").addEventListener("click", async () => {
      if (estado.reposicao[produto.id] < estoque) {
        const novaQtd = estado.reposicao[produto.id] + 1;
        estado.reposicao[produto.id] = novaQtd;
        renderizarModalReposicao();
        try {
          await setItemReposicao(produto.id, novaQtd);
        } catch (err) {
          estado.reposicao[produto.id] = novaQtd - 1; // reverte
          renderizarModalReposicao();
          showToast("Erro ao atualizar", "❌");
          console.error(err);
        }
      } else {
        showToast(`Estoque máximo é ${estoque}`, "⚠️");
      }
    });

    container.appendChild(div);
  });
}

// ── Imprimir lista ────────────────────────────────────────────────
function imprimirLista() {
  if (totalProdutosReposicao() === 0) { showToast("Lista vazia", "⚠️"); return; }
  const corpo  = document.getElementById("corpoImpressao");
  const dataEl = document.getElementById("impressaoData");
  const tituloEl = document.getElementById("impressaoTitulo");

  if (tituloEl) tituloEl.textContent = `🛒 ${nomeListaAtiva()} · ${nomeLoja(estado.lojaAtiva)}`;

  // Formata data atual em pt-BR
  const agora = new Date();
  const dataFmt = agora.toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
  dataEl.textContent = `Loja ${nomeLoja(estado.lojaAtiva)} · Gerada em ${dataFmt}`;

  // Monta a tabela (na ordem em que foram selecionados)
  corpo.innerHTML = "";
  const itens = idsReposicaoOrdenados()
    .map(id => estado.todosProdutos.find(p => p.id === id))
    .filter(p => p);

  itens.forEach((produto, index) => {
    const estoque = Number(produto.quantidade) || 0;
    const aLevar  = estado.reposicao[produto.id];
    const barcode = produto.codigoBarras || "—";
    const local   = rotuloEstoque(produto.estoque) || "—";

    // A miniatura é base64 guardada no próprio produto, então imprime mesmo offline.
    // Sem foto, mostra um quadradinho vazio para a coluna não desalinhar.
    const fotoImpressao = produto.thumb || produto.imagem;
    const celulaFoto = fotoImpressao
      ? `<img src="${fotoImpressao}" class="img-impressao" alt="">`
      : `<span class="img-impressao-vazia">—</span>`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${celulaFoto}</td>
      <td>${produto.nome}</td>
      <td>${local}</td>
      <td>${barcode}</td>
      <td>${estoque}</td>
      <td><strong>${aLevar}</strong></td>
    `;
    corpo.appendChild(tr);
  });

  // Aciona impressão do navegador
  window.print();
}

// ── Compartilhar lista ────────────────────────────────────────────
async function compartilharLista() {
  if (totalProdutosReposicao() === 0) { showToast("Lista vazia", "⚠️"); return; }
  const itens = idsReposicaoOrdenados()
    .map(id => estado.todosProdutos.find(p => p.id === id))
    .filter(p => p);

  const agora = new Date();
  const dataFmt = agora.toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  let texto = `🛒 *${nomeListaAtiva()} · ${nomeLoja(estado.lojaAtiva)}*\n_Gerada em ${dataFmt}_\n\n`;
  itens.forEach((produto, index) => {
    const estoque = Number(produto.quantidade) || 0;
    const aLevar  = estado.reposicao[produto.id];
    const barcode = produto.codigoBarras ? ` (${produto.codigoBarras})` : "";
    const local   = rotuloEstoque(produto.estoque);
    const linhaLocal = local ? `   📍 ${local}\n` : "";
    texto += `${index + 1}. *${produto.nome}*${barcode}\n${linhaLocal}   Estoque: ${estoque} un · *Levar: ${aLevar} un*\n\n`;
  });
  texto += "_Estoque da Papelaria_";

  // Tenta Web Share API (mobile) → fallback pra clipboard
  if (navigator.share) {
    try {
      await navigator.share({ title: "Lista de Reposição", text: texto });
    } catch (err) {
      // Usuário cancelou — sem ação
      if (err.name !== "AbortError") {
        copiarParaClipboard(texto);
      }
    }
  } else {
    copiarParaClipboard(texto);
  }
}

async function copiarParaClipboard(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    showToast("Lista copiada! Cole no WhatsApp", "📋");
  } catch (err) {
    showToast("Não foi possível copiar", "❌");
    console.error(err);
  }
}

// ── Finalizar reposição (descontar do estoque) ────────────────────
async function finalizarReposicao() {
  const itens = Object.keys(estado.reposicao)
    .map(id => ({
      id,
      qtdLevar: estado.reposicao[id],
      produto: estado.todosProdutos.find(p => p.id === id)
    }))
    .filter(item => item.produto);

  if (itens.length === 0) {
    showToast("Lista vazia", "⚠️");
    return;
  }

  // Monta mensagem de confirmação
  const resumo = itens
    .map(({ produto, qtdLevar }) => `• ${qtdLevar} ${produto.nome}`)
    .join("\n");

  const confirma = confirm(
    `Confirmar saída do depósito?\n\nVai ser descontado do estoque:\n${resumo}\n\nEssa ação não pode ser desfeita.`
  );

  if (!confirma) return;

  const btn     = document.getElementById("btnFinalizarReposicao");
  const spinner = document.getElementById("spinnerFinalizar");
  const texto   = document.getElementById("textoFinalizar");

  btn.disabled = true;
  spinner.classList.add("ativo");
  texto.textContent = "Descontando...";

  try {
    // Marca como ação local pra o listener não disparar o toast de "finalizada em outro dispositivo"
    estado.finalizandoLocal = true;

    // Faz tudo numa única operação atômica (batch): desconta estoque + limpa lista
    const batch = writeBatch(window.db);
    itens.forEach(({ id, qtdLevar, produto }) => {
      const novoEstoque = Math.max(0, (Number(produto.quantidade) || 0) - qtdLevar);
      batch.update(doc(window.db, "produtos", id), { quantidade: novoEstoque });
    });
    // Apaga a lista no mesmo batch (atomicidade total).
    // O listener percebe que ela sumiu e passa para a próxima lista aberta.
    batch.delete(refReposicao());
    await batch.commit();

    fecharModal("modalReposicao");
    showToast(`${itens.length} produto(s) descontado(s) do estoque!`, "✅");
    await mostrarProdutos();
  } catch (err) {
    estado.finalizandoLocal = false; // reseta a flag em caso de erro
    showToast("Erro ao descontar do estoque", "❌");
    console.error(err);
  } finally {
    btn.disabled = false;
    spinner.classList.remove("ativo");
    texto.textContent = "✅ Finalizar e descontar do estoque";
  }
}

// ── Excluir lista de reposição (sem descontar do estoque) ─────────
async function excluirListaAtiva() {
  const l = listaAtiva();
  if (!l) return;

  const total = totalProdutosReposicao();
  const msg = total > 0
    ? `Excluir "${l.nome}" com ${total} produto(s)?\n\nNada será descontado do estoque.`
    : `Excluir "${l.nome}"?`;
  if (!confirm(msg)) return;

  // Marca como ação local pra o listener não disparar o toast de outro dispositivo
  estado.finalizandoLocal = true;
  fecharModal("modalReposicao");

  try {
    await deleteDoc(doc(window.db, LISTAS_COLLECTION, l.id));
    showToast(`"${l.nome}" excluída`, "🗑️");
  } catch (err) {
    estado.finalizandoLocal = false;
    showToast("Erro ao excluir lista", "❌");
    console.error(err);
  }
}

// ── Scanner de câmera (genérico) ─────────────────────────────────
// Usa BarcodeDetector nativo quando disponível (Chrome Android/Desktop)
// e cai pra ZXing como fallback (Safari iOS, Firefox, etc.).
async function iniciarScannerGenerico(scannerState, config) {
  const { areaId, videoId, btnId, onDetect } = config;
  const area  = document.getElementById(areaId);
  const video = document.getElementById(videoId);
  const btn   = document.getElementById(btnId);

  try {
    scannerState.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    video.srcObject = scannerState.stream;
    video.setAttribute("playsinline", "true"); // garante inline no iOS
    video.muted = true;
    area.style.display = "block";
    btn.classList.add("ativo");
    scannerState.ativo = true;

    // iOS às vezes não dá play sozinho — forçamos
    try { await video.play(); } catch (_) {}

    // Flag para garantir que só processamos UMA detecção por sessão.
    // Sem isso, o ZXing continua disparando o callback em loop até o
    // stream ser totalmente fechado, causando "código escaneado" piscando.
    scannerState.detectado = false;
    const callback = (codigo) => {
      if (scannerState.detectado) return;
      scannerState.detectado = true;
      pararScannerGenerico(scannerState, areaId, btnId);
      onDetect(codigo);
    };

    if ("BarcodeDetector" in window) {
      // ── Caminho rápido: API nativa (Chrome Android/Desktop)
      const detector = new BarcodeDetector({ formats: BARCODE_FORMATS });
      scannerState.interval = setInterval(async () => {
        if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) callback(barcodes[0].rawValue);
        } catch (_) {}
      }, SCANNER_INTERVALO_MS);
    } else {
      // ── Fallback: ZXing (Safari iOS, etc.) — carregado sob demanda
      const ReaderClass = await carregarZXing();
      const reader = new ReaderClass();
      scannerState.zxingReader = reader;
      reader.decodeFromStream(scannerState.stream, video, (result, err) => {
        if (result) callback(result.getText());
        // erros de "não encontrou nada nesse frame" são normais — ignoramos
      }).catch((e) => {
        console.error("Erro ZXing:", e);
      });

      const hint = area.querySelector(".scan-hint");
      if (hint) hint.textContent = "Aponte a câmera para o código de barras";
    }
  } catch (err) {
    showToast("Não foi possível acessar a câmera", "❌");
    console.error(err);
  }
}

function pararScannerGenerico(scannerState, areaId, btnId) {
  clearInterval(scannerState.interval);
  scannerState.interval = null;

  // Para o leitor ZXing, se estiver ativo
  if (scannerState.zxingReader) {
    try { scannerState.zxingReader.reset(); } catch (_) {}
    scannerState.zxingReader = null;
  }

  if (scannerState.stream) {
    scannerState.stream.getTracks().forEach(t => t.stop());
    scannerState.stream = null;
  }

  const area = document.getElementById(areaId);
  if (area) area.style.display = "none";
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.remove("ativo");
  scannerState.ativo = false;
}

// ── Scanner integrado na busca principal ─────────────────────────
window.alternarScannerBusca = async function () {
  if (estado.scannerBusca.ativo) {
    pararScannerGenerico(estado.scannerBusca, "scannerAreaBusca", "btnBuscaCam");
    return;
  }
  await iniciarScannerGenerico(estado.scannerBusca, {
    areaId:  "scannerAreaBusca",
    videoId: "scannerVideoBusca",
    btnId:   "btnBuscaCam",
    onDetect: (codigo) => {
      const campo = document.getElementById("campoBusca");
      campo.value = codigo;
      estado.termoBusca = codigo.toLowerCase();

      // Limpa o filtro de local pra não esconder o produto escaneado
      estado.filtroEstoque = "";
      document.querySelectorAll(".chip-estoque").forEach(chip => {
        chip.classList.toggle("ativo", chip.dataset.estoque === "");
      });

      const encontrados = estado.todosProdutos.filter(p =>
        p.codigoBarras && p.codigoBarras.includes(codigo)
      );
      renderizarLista(encontrados);

      if (encontrados.length === 0) {
        showToast(`Código ${codigo} não cadastrado`, "⚠️");
      } else {
        showToast("Código escaneado!", "✅");
      }
    }
  });
};

window.alternarScannerEditar = async function () {
  if (estado.scannerEditar.ativo) {
    pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");
    return;
  }
  await iniciarScannerGenerico(estado.scannerEditar, {
    areaId:  "scannerAreaEditar",
    videoId: "scannerVideoEditar",
    btnId:   "btnScanEditar",
    onDetect: (codigo) => {
      document.getElementById("inputEditarBarcode").value = codigo;

      // Verifica se o código está em uso por OUTRO produto (ignora o que está sendo editado)
      const existente = estado.todosProdutos.find(
        p => p.codigoBarras && p.codigoBarras === codigo && p.id !== estado.editarId
      );
      if (existente) {
        showToast(`Código já cadastrado em "${existente.nome}"`, "⚠️");
      } else {
        showToast("Código capturado!", "✅");
      }
    }
  });
};

window.alternarScannerAdd = async function () {
  if (estado.scannerAdd.ativo) {
    pararScannerGenerico(estado.scannerAdd, "scannerAreaAdd", "btnScanAdd");
    return;
  }
  await iniciarScannerGenerico(estado.scannerAdd, {
    areaId:  "scannerAreaAdd",
    videoId: "scannerVideoAdd",
    btnId:   "btnScanAdd",
    onDetect: (codigo) => {
      document.getElementById("codigoBarrasProduto").value = codigo;

      const existente = estado.todosProdutos.find(
        p => p.codigoBarras && p.codigoBarras === codigo
      );
      if (existente) {
        showToast(`Código já cadastrado em "${existente.nome}"`, "⚠️");
      } else {
        showToast("Código capturado!", "✅");
      }
    }
  });
};

// Baixa um arquivo JSON com todos os produtos, do jeito que estão agora.
// Rede de segurança antes da migração. Rode pelo console: baixarBackup()
window.baixarBackup = async function () {
  console.log("Baixando todos os produtos do servidor...");
  const snapshot = await getDocs(collection(window.db, "produtos"));

  const dados = [];
  snapshot.forEach((d) => dados.push({ id: d.id, ...d.data() }));

  const json = JSON.stringify(dados);
  const tamanhoMB = (json.length / 1024 / 1024).toFixed(1);

  const data = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = `backup-produtos-${data}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);

  console.log(`✅ Backup gerado: ${dados.length} produtos, ~${tamanhoMB} MB.`);
  console.log("Confira se o arquivo apareceu na pasta Downloads antes de migrar.");
  return `${dados.length} produtos salvos`;
};

// ── Migração única: separar fotos antigas ────────────────────────
// Converte os produtos que ainda guardam a foto grande no campo "imagem":
//   1. gera a miniatura e grava em "thumb" no próprio produto
//   2. copia a foto grande pra coleção produtosImagens/<id>
//   3. apaga o campo "imagem" do produto (é o que estava pesando na lista)
// Roda pelo console: migrarFotos()
// É segura de rodar mais de uma vez — pula quem já foi migrado, então se
// travar no meio ou você fechar a aba, é só rodar de novo que continua.
//
// IMPORTANTE: com o cache local ativo, setDoc/updateDoc retornam assim que
// gravam no IndexedDB, ANTES do servidor confirmar. Por isso processamos em
// lotes pequenos e usamos waitForPendingWrites() entre eles: assim esperamos
// o servidor de verdade e a fila de envio do Firestore não estoura.
window.migrarFotos = async function (tamanhoLote = 10) {
  console.log("Buscando produtos direto do servidor...");
  const snapshot = await getDocs(collection(window.db, "produtos"));

  const pendentes = [];
  snapshot.forEach((d) => {
    const dados = d.data();
    if (dados.imagem) pendentes.push({ id: d.id, nome: dados.nome, imagem: dados.imagem });
  });

  if (pendentes.length === 0) {
    console.log("✅ Nada a migrar — todos os produtos já estão no formato novo.");
    return;
  }

  const total = pendentes.length;
  console.log(`Encontrados ${total} produto(s) para migrar.`);
  console.log("Isso leva vários minutos, e é lento de propósito para não");
  console.log("sobrecarregar o Firestore. Deixe a aba aberta e aguarde.");

  let ok = 0, falhas = 0, processados = 0;
  const erros = [];
  const inicio = Date.now();

  async function migrarUm(prod) {
    const thumb = await gerarThumbDeBase64(prod.imagem);

    // 1) guarda a foto grande na coleção separada (cópia ANTES de apagar)
    await setDoc(doc(window.db, IMAGENS_COLLECTION, prod.id), {
      imagem: prod.imagem,
      atualizadoEm: serverTimestamp()
    });

    // 2) grava a miniatura e remove o campo pesado do produto
    await updateDoc(doc(window.db, "produtos", prod.id), {
      thumb,
      imagem: deleteField()
    });
  }

  for (let i = 0; i < total; i += tamanhoLote) {
    const lote = pendentes.slice(i, i + tamanhoLote);

    const resultados = await Promise.allSettled(lote.map(migrarUm));
    resultados.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        ok++;
      } else {
        falhas++;
        erros.push({
          nome: lote[idx].nome,
          id: lote[idx].id,
          erro: r.reason?.message || String(r.reason)
        });
      }
    });
    processados += lote.length;

    // Espera o servidor confirmar TUDO que foi enfileirado até aqui.
    // É esta linha que impede a fila de envio de estourar.
    try {
      await waitForPendingWrites(window.db);
    } catch (err) {
      console.warn("Aguardando reconexão com o servidor...", err?.message || err);
      await new Promise(r => setTimeout(r, 3000));
    }

    const pct = Math.round((processados / total) * 100);
    const seg = Math.round((Date.now() - inicio) / 1000);
    const restante = total - processados;
    const estimativa = processados > 0
      ? Math.round((seg / processados) * restante)
      : 0;
    console.log(
      `${pct}% — ${processados}/${total} confirmados no servidor ` +
      `(${ok} ok, ${falhas} falhas) — ${seg}s decorridos, ~${estimativa}s restantes`
    );
  }

  const segundos = Math.round((Date.now() - inicio) / 1000);
  console.log(`\n=== Migração concluída em ${segundos}s ===`);
  console.log(`${ok} migrado(s), ${falhas} falha(s).`);

  if (falhas > 0) {
    console.log("Produtos que falharam:");
    console.table(erros);
    console.log("Rode migrarFotos() de novo para tentar só os que faltaram.");
  } else {
    console.log("Rode statusMigracao() para confirmar, depois recarregue com Ctrl+Shift+R.");
  }
};

// Mostra quantos produtos ainda faltam migrar, sem alterar nada.
window.statusMigracao = async function () {
  const snapshot = await getDocs(collection(window.db, "produtos"));
  let comImagemAntiga = 0, comThumb = 0, semFoto = 0;

  snapshot.forEach((d) => {
    const dados = d.data();
    if (dados.imagem) comImagemAntiga++;
    else if (dados.thumb) comThumb++;
    else semFoto++;
  });

  console.log(`Total de produtos: ${snapshot.size}`);
  console.log(`  Falta migrar:     ${comImagemAntiga}`);
  console.log(`  Já migrados:      ${comThumb}`);
  console.log(`  Sem foto:         ${semFoto}`);
};

// ── Event Listeners ───────────────────────────────────────────────

// Pequeno atraso antes de filtrar: evita reconstruir a lista inteira
// a cada tecla digitada (importante com muitas fotos na lista).
function debounce(fn, atrasoMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), atrasoMs);
  };
}
const filtrarProdutosDebounced = debounce(() => window.filtrarProdutos(), 180);

document.getElementById("btnAdicionar").addEventListener("click", window.adicionarProduto);
document.getElementById("campoBusca").addEventListener("input", filtrarProdutosDebounced);
document.getElementById("campoBusca").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    window.filtrarProdutos();
    e.target.blur(); // esconde o teclado no celular

    // Se o termo parece um código de barras (só dígitos, 8+) e nada foi encontrado, avisa
    const termo = e.target.value.trim();
    const pareceCodigo = /^\d{8,}$/.test(termo);
    if (pareceCodigo) {
      const encontrou = estado.todosProdutos.some(p =>
        p.codigoBarras && p.codigoBarras.includes(termo)
      );
      if (!encontrou) {
        showToast(`Código ${termo} não cadastrado`, "⚠️");
      }
    }
  }
});
document.getElementById("btnBuscaCam").addEventListener("click", window.alternarScannerBusca);

// Os chips de filtro por local são criados dinamicamente em
// renderizarFiltrosEstoque() — os eventos são ligados lá.

// Modal de gerenciar locais
document.getElementById("btnFecharLocais").addEventListener("click", () => fecharModal("modalLocais"));
document.getElementById("btnCriarLocal").addEventListener("click", criarLocalPeloModal);
document.getElementById("inputNovoLocal").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    criarLocalPeloModal();
  }
});

// Botões de troca de loja
document.querySelectorAll(".chip-loja").forEach(btn => {
  btn.addEventListener("click", () => trocarLoja(btn.dataset.loja));
});
atualizarBotoesLoja();
renderizarSeletorListas();

// Desenha os locais com os valores padrão enquanto o Firestore não responde
// (o listener substitui assim que os dados reais chegam)
renderizarFiltrosEstoque();
renderizarSelectsEstoque();

document.getElementById("modalFoto").addEventListener("click", () => fecharModal("modalFoto"));
document.querySelector("#modalFoto .modal-foto-box").addEventListener("click", (e) => e.stopPropagation());
document.getElementById("btnFecharFoto").addEventListener("click", () => fecharModal("modalFoto"));

document.getElementById("btnCancelarEditar").addEventListener("click", () => {
  pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");
  fecharModal("modalEditar");
});
document.getElementById("btnSalvarEditar").addEventListener("click", window.salvarEdicao);
document.getElementById("btnScanEditar").addEventListener("click", window.alternarScannerEditar);
document.getElementById("btnScanAdd").addEventListener("click", window.alternarScannerAdd);
document.getElementById("inputEditarFoto").addEventListener("change", escolherFotoEditar);
document.getElementById("btnRemoverFoto").addEventListener("click", removerFotoEditar);

document.getElementById("btnCancelarAjuste").addEventListener("click", () => fecharModal("modalRemoverQtd"));
document.getElementById("btnAjusteAdd").addEventListener("click", () => confirmarAjusteQtd("add"));
document.getElementById("btnAjusteRem").addEventListener("click", () => confirmarAjusteQtd("rem"));
document.getElementById("inputRemoverQtd").addEventListener("keydown", (e) => {
  if (e.key === "Enter") confirmarAjusteQtd("add");
});

// ── Listeners da Lista de Reposição ───────────────────────────────
document.getElementById("bannerReposicao").addEventListener("click", abrirModalReposicao);
document.getElementById("btnFecharReposicao").addEventListener("click", () => fecharModal("modalReposicao"));
document.getElementById("btnImprimirLista").addEventListener("click", imprimirLista);
document.getElementById("btnCompartilharLista").addEventListener("click", compartilharLista);
document.getElementById("btnFinalizarReposicao").addEventListener("click", finalizarReposicao);
document.getElementById("btnLimparReposicao").addEventListener("click", excluirListaAtiva);
document.getElementById("btnRenomearLista").addEventListener("click", renomearListaAtiva);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    fecharModal("modalFoto");
    pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");
    fecharModal("modalEditar");
    fecharModal("modalRemoverQtd");
    fecharModal("modalReposicao");
    fecharModal("modalLocais");
    pararScannerGenerico(estado.scannerBusca, "scannerAreaBusca", "btnBuscaCam");
    pararScannerGenerico(estado.scannerAdd, "scannerAreaAdd", "btnScanAdd");
  }
});

// (O banner é atualizado automaticamente pelo listener da lista de reposição
//  assim que o snapshot inicial do Firestore chega.)