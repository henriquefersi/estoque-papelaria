import {
  collection,
  addDoc,
  getDocs,
  doc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const lista      = document.getElementById("listaProdutos");
const overlay    = document.getElementById("loadingOverlay");
const toast      = document.getElementById("toast");

/* ════════════════════════════════════
   HELPERS DE UI
════════════════════════════════════ */

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

/* ════════════════════════════════════
   UPLOAD DE IMAGEM (com compressão)
════════════════════════════════════ */

let imagemBase64 = "";

const uploadArea = document.getElementById("uploadArea");
const fileInput  = document.getElementById("fileInput");
const preview    = document.getElementById("uploadPreview");

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 400;
      const scale = Math.min(1, MAX / img.width);
      const canvas = document.createElement("canvas");
      canvas.width  = img.width  * scale;
      canvas.height = img.height * scale;
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      imagemBase64 = canvas.toDataURL("image/jpeg", 0.7);
      preview.src = imagemBase64;
      uploadArea.classList.add("has-image");
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

function resetUpload() {
  imagemBase64 = "";
  preview.src = "";
  uploadArea.classList.remove("has-image");
  fileInput.value = "";
}

/* ════════════════════════════════════
   CACHE DE PRODUTOS (para busca/barcode)
════════════════════════════════════ */

let todosProdutos = []; // { id, nome, quantidade, imagem, codigoBarras? }

/* ════════════════════════════════════
   LISTAR / FILTRAR PRODUTOS
════════════════════════════════════ */

async function mostrarProdutos() {
  showLoading("Buscando produtos...");
  lista.innerHTML = "";

  try {
    const querySnapshot = await getDocs(collection(window.db, "produtos"));

    todosProdutos = [];
    querySnapshot.forEach((documento) => {
      const p = documento.data();
      todosProdutos.push({ id: documento.id, ...p });
    });

    renderizarLista(todosProdutos);

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
    const quantidade  = Number(produto.quantidade) || 0;
    const imagem      = produto.imagem || "https://placehold.co/52x52/1a1a24/8888aa?text=?";
    const estoqueClass = quantidade <= 2 ? "estoque-baixo" : "";
    const estoqueLabel = quantidade <= 2 ? `⚠️ ${quantidade}` : quantidade;

    const li = document.createElement("li");
    li.className = "produto-item";
    li.innerHTML = `
      <img src="${imagem}" class="img-produto"
           title="Clique para ampliar"
           onerror="this.src='https://placehold.co/52x52/1a1a24/8888aa?text=?'">
      <div class="produto-info">
        <span class="nome-produto">${produto.nome}</span>
        <span class="quantidade-produto ${estoqueClass}">Quantidade: ${estoqueLabel}</span>
      </div>
      <div class="acoes">
        <button class="btn-acao btn-mais"      title="Adicionar 1">+</button>
        <button class="btn-acao btn-menos"     title="Remover 1">−</button>
        <button class="btn-acao btn-minus-qtd" title="Remover quantidade">−N</button>
        <button class="btn-acao btn-editar"    title="Editar nome">✏️</button>
        <button class="btn-acao btn-remover"   title="Excluir produto">🗑</button>
      </div>
    `;

    // Foto → ampliar
    li.querySelector(".img-produto").addEventListener("click", () =>
      abrirModalFoto(imagem)
    );

    // Botões de quantidade
    li.querySelector(".btn-mais").addEventListener("click", () => aumentar(produto.id, quantidade));
    li.querySelector(".btn-menos").addEventListener("click", () => diminuir(produto.id, quantidade));
    li.querySelector(".btn-minus-qtd").addEventListener("click", () => abrirModalRemoverQtd(produto.id, produto.nome, quantidade));

    // Editar nome
    li.querySelector(".btn-editar").addEventListener("click", () => abrirModalEditar(produto.id, produto.nome));

    // Remover produto
    li.querySelector(".btn-remover").addEventListener("click", () => confirmarRemover(produto.id, produto.nome));

    lista.appendChild(li);

    totalProdutos++;
    totalItens += quantidade;
  });

  document.getElementById("totalProdutos").textContent = totalProdutos;
  document.getElementById("totalItens").textContent    = totalItens;
}

window.mostrarProdutos = mostrarProdutos;

/* ── Busca por texto ── */
window.filtrarProdutos = function () {
  const termo = document.getElementById("campoBusca").value.trim().toLowerCase();
  if (!termo) {
    renderizarLista(todosProdutos);
    return;
  }
  const filtrados = todosProdutos.filter(p =>
    p.nome.toLowerCase().includes(termo)
  );
  renderizarLista(filtrados);
};

/* ════════════════════════════════════
   ADICIONAR PRODUTO
════════════════════════════════════ */

window.adicionarProduto = async function () {
  const nome      = document.getElementById("nomeProduto").value.trim();
  const quantidade = parseInt(document.getElementById("quantidadeProduto").value);
  const btn       = document.getElementById("btnAdicionar");
  const spinner   = document.getElementById("btnSpinner");
  const btnText   = document.getElementById("btnText");

  if (!nome || isNaN(quantidade) || quantidade < 1) {
    showToast("Preencha o nome e a quantidade corretamente", "⚠️");
    return;
  }

  btn.disabled = true;
  spinner.classList.add("ativo");
  btnText.textContent = "Adicionando...";

  try {
    await addDoc(collection(window.db, "produtos"), {
      nome,
      quantidade,
      imagem: imagemBase64 || ""
    });

    document.getElementById("nomeProduto").value    = "";
    document.getElementById("quantidadeProduto").value = "";
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

/* ════════════════════════════════════
   AUMENTAR / DIMINUIR 1
════════════════════════════════════ */

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

/* ════════════════════════════════════
   MODAL: REMOVER QUANTIDADE
════════════════════════════════════ */

let _removerQtdId       = null;
let _removerQtdNome     = "";
let _removerQtdAtual    = 0;

function abrirModalRemoverQtd(id, nome, qtdAtual) {
  _removerQtdId    = id;
  _removerQtdNome  = nome;
  _removerQtdAtual = qtdAtual;
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

  if (tipo === "rem" && qtd > _removerQtdAtual) {
    showToast(`Estoque atual é só ${_removerQtdAtual}`, "⚠️");
    return;
  }

  const isAdd     = tipo === "add";
  const spinnerId = isAdd ? "spinnerAjusteAdd" : "spinnerAjusteRem";
  const textoId   = isAdd ? "textoAjusteAdd"   : "textoAjusteRem";
  const btnEl     = isAdd
    ? document.getElementById("btnAjusteAdd")
    : document.getElementById("btnAjusteRem");
  const spinner   = document.getElementById(spinnerId);
  const texto     = document.getElementById(textoId);

  btnEl.disabled = true;
  spinner.classList.add("ativo");
  texto.textContent = isAdd ? "Adicionando..." : "Removendo...";

  const novaQtd = isAdd ? _removerQtdAtual + qtd : _removerQtdAtual - qtd;

  try {
    await updateDoc(doc(window.db, "produtos", _removerQtdId), { quantidade: novaQtd });
    fecharModal("modalRemoverQtd");
    showToast(
      isAdd
        ? `+${qtd} adicionado(s) a "${_removerQtdNome}"`
        : `−${qtd} removido(s) de "${_removerQtdNome}"`
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

document.getElementById("btnCancelarAjuste").addEventListener("click", () => fecharModal("modalRemoverQtd"));
document.getElementById("btnAjusteAdd").addEventListener("click", () => confirmarAjusteQtd("add"));
document.getElementById("btnAjusteRem").addEventListener("click", () => confirmarAjusteQtd("rem"));
document.getElementById("inputRemoverQtd").addEventListener("keydown", (e) => {
  if (e.key === "Enter") confirmarAjusteQtd("add");
});

/* ════════════════════════════════════
   MODAL: EDITAR NOME
════════════════════════════════════ */

let _editarId = null;

function abrirModalEditar(id, nomeAtual) {
  _editarId = id;
  document.getElementById("inputEditarNome").value = nomeAtual;
  abrirModal("modalEditar");
  setTimeout(() => document.getElementById("inputEditarNome").focus(), 100);
}

window.fecharModalEditar = function () {
  fecharModal("modalEditar");
};

window.salvarEdicao = async function () {
  const novoNome = document.getElementById("inputEditarNome").value.trim();
  if (!novoNome) { showToast("Digite um nome válido", "⚠️"); return; }

  const btn     = document.querySelector("#modalEditar .btn-modal-confirm");
  const spinner = document.getElementById("spinnerEditar");
  const texto   = document.getElementById("textoSalvar");

  btn.disabled = true;
  spinner.classList.add("ativo");
  texto.textContent = "Salvando...";

  try {
    await updateDoc(doc(window.db, "produtos", _editarId), { nome: novoNome });
    fecharModal("modalEditar");
    showToast(`Nome atualizado para "${novoNome}"`);
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

// Enter para salvar edição
document.getElementById("inputEditarNome").addEventListener("keydown", (e) => {
  if (e.key === "Enter") window.salvarEdicao();
});

/* ════════════════════════════════════
   MODAL: AMPLIAR FOTO
════════════════════════════════════ */

function abrirModalFoto(src) {
  if (!src || src.includes("placehold.co")) return;
  document.getElementById("modalFotoImg").src = src;
  abrirModal("modalFoto");
}

window.fecharModalFoto = function () {
  fecharModal("modalFoto");
};

// Fechar com ESC
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    fecharModal("modalFoto");
    fecharModal("modalEditar");
    fecharModal("modalRemoverQtd");
    fecharModalBarcode();
  }
});

/* ════════════════════════════════════
   REMOVER PRODUTO COMPLETO
════════════════════════════════════ */

function confirmarRemover(id, nome) {
  if (confirm(`Excluir "${nome}" do estoque?`)) remover(id, nome);
}

async function remover(id, nome) {
  showLoading("Removendo produto...");
  try {
    await deleteDoc(doc(window.db, "produtos", id));
    showToast(`"${nome}" removido`, "🗑️");
    await mostrarProdutos();
  } catch (err) {
    showToast("Erro ao remover", "❌");
    hideLoading();
  }
}

/* ════════════════════════════════════
   MODAL: CÓDIGO DE BARRAS
════════════════════════════════════ */

let scannerStream   = null;
let scannerInterval = null;
let scannerAtivo    = false;

window.abrirModalBarcode = function () {
  document.getElementById("inputBarcode").value = "";
  document.getElementById("barcodeResultado").style.display = "none";
  document.getElementById("barcodeResultado").className = "barcode-resultado";
  document.getElementById("scannerArea").style.display = "none";
  document.getElementById("btnScan").classList.remove("ativo");
  scannerAtivo = false;
  abrirModal("modalBarcode");
  setTimeout(() => document.getElementById("inputBarcode").focus(), 100);
};

window.fecharModalBarcode = function () {
  pararScanner();
  fecharModal("modalBarcode");
};

window.buscarPorBarcode = function () {
  const codigo = document.getElementById("inputBarcode").value.trim();
  if (!codigo) { showToast("Digite o código de barras", "⚠️"); return; }
  _buscarNaLista(codigo);
};

function _buscarNaLista(codigo) {
  const resultado = document.getElementById("barcodeResultado");
  resultado.style.display = "block";

  // Busca pelo campo codigoBarras ou pelo nome que contenha o código
  const encontrado = todosProdutos.find(p =>
    (p.codigoBarras && p.codigoBarras === codigo) ||
    (p.nome && p.nome.toLowerCase().includes(codigo.toLowerCase()))
  );

  if (encontrado) {
    const qtd = Number(encontrado.quantidade) || 0;
    resultado.className = "barcode-resultado encontrado";
    resultado.innerHTML = `
      <div class="barcode-prod-nome">✅ ${encontrado.nome}</div>
      <div class="barcode-prod-qtd">Quantidade em estoque: ${qtd}</div>
    `;
  } else {
    resultado.className = "barcode-resultado nao-encontrado";
    resultado.innerHTML = `<div>❌ Produto com código <strong>${codigo}</strong> não encontrado no estoque.</div>`;
  }
}

/* ── Scanner de câmera (BarcodeDetector nativo ou fallback) ── */

window.alternarScanner = async function () {
  if (scannerAtivo) {
    pararScanner();
    return;
  }
  await iniciarScanner();
};

async function iniciarScanner() {
  const area  = document.getElementById("scannerArea");
  const video = document.getElementById("scannerVideo");
  const btn   = document.getElementById("btnScan");

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
    video.srcObject = scannerStream;
    area.style.display = "block";
    btn.classList.add("ativo");
    scannerAtivo = true;

    // Tenta usar BarcodeDetector nativo (Chrome/Android)
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["ean_13","ean_8","code_128","code_39","qr_code","upc_a","upc_e"] });
      scannerInterval = setInterval(async () => {
        if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) {
            const codigo = barcodes[0].rawValue;
            document.getElementById("inputBarcode").value = codigo;
            _buscarNaLista(codigo);
            pararScanner();
          }
        } catch (_) {}
      }, 500);
    } else {
      // Fallback: avisa que o navegador não suporta scan automático
      document.querySelector(".scan-hint").textContent =
        "Câmera ativa. Se seu navegador não detectar automaticamente, use o campo acima para digitar o código.";
    }

  } catch (err) {
    showToast("Não foi possível acessar a câmera", "❌");
    console.error(err);
  }
}

function pararScanner() {
  clearInterval(scannerInterval);
  scannerInterval = null;

  if (scannerStream) {
    scannerStream.getTracks().forEach(t => t.stop());
    scannerStream = null;
  }

  document.getElementById("scannerArea").style.display = "none";
  document.getElementById("btnScan").classList.remove("ativo");
  scannerAtivo = false;
}

/* ── Enter para buscar código manualmente ── */
document.getElementById("inputBarcode").addEventListener("keydown", (e) => {
  if (e.key === "Enter") window.buscarPorBarcode();
});

/* ════════════════════════════════════
   INIT
════════════════════════════════════ */
mostrarProdutos();