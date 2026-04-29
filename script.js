import {
  collection,
  addDoc,
  getDocs,
  doc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

// ── Constantes ───────────────────────────────────────────────────
const LIMITE_ESTOQUE_BAIXO = 2;
const QUALIDADE_IMAGEM     = 0.7;
const TAMANHO_MAX_IMAGEM   = 400;
const SCANNER_INTERVALO_MS = 500;
const BARCODE_FORMATS      = ["ean_13","ean_8","code_128","code_39","qr_code","upc_a","upc_e"];

// ── Estado centralizado ──────────────────────────────────────────
const estado = {
  todosProdutos:    [],
  imagemBase64:     "",
  imagemCarregando: false,
  produtoAtual:     { id: null, nome: "", qtd: 0 },
  editarId:         null,
  termoBusca:       "",          // mantém o filtro ativo após alterações
  scannerBusca:     { stream: null, interval: null, ativo: false },
  scannerEditar:    { stream: null, interval: null, ativo: false }
};

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

// ── Upload de imagem ─────────────────────────────────────────────
const uploadArea = document.getElementById("uploadArea");
const fileInput  = document.getElementById("fileInput");
const preview    = document.getElementById("uploadPreview");

function comprimirImagem(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale  = Math.min(1, TAMANHO_MAX_IMAGEM / img.width);
        const canvas = document.createElement("canvas");
        canvas.width  = img.width  * scale;
        canvas.height = img.height * scale;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", QUALIDADE_IMAGEM));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  estado.imagemCarregando = true;
  try {
    estado.imagemBase64 = await comprimirImagem(file);
    preview.src = estado.imagemBase64;
    uploadArea.classList.add("has-image");
  } catch {
    showToast("Erro ao processar imagem", "❌");
    estado.imagemBase64 = "";
  } finally {
    estado.imagemCarregando = false;
  }
});

function resetUpload() {
  estado.imagemBase64     = "";
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
    // Reaplicar o filtro ativo (mantém a busca após alterações)
    if (estado.termoBusca) {
      const termo = estado.termoBusca.toLowerCase();
      renderizarLista(estado.todosProdutos.filter(p =>
        p.nome.toLowerCase().includes(termo) ||
        (p.codigoBarras && p.codigoBarras.includes(termo))
      ));
    } else {
      renderizarLista(estado.todosProdutos);
    }
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
    const imagem       = produto.imagem || "https://placehold.co/52x52/1a1a24/8888aa?text=?";
    const estoqueClass = quantidade <= LIMITE_ESTOQUE_BAIXO ? "estoque-baixo" : "";
    const estoqueLabel = quantidade <= LIMITE_ESTOQUE_BAIXO ? `⚠️ ${quantidade}` : quantidade;
    const ariaEstoque  = quantidade <= LIMITE_ESTOQUE_BAIXO ? " (estoque baixo)" : "";

    const barcodeTag = produto.codigoBarras
      ? `<span class="barcode-tag" title="Código de barras">⬛ ${produto.codigoBarras}</span>`
      : "";

    const li = document.createElement("li");
    li.className = "produto-item";
    li.innerHTML = `
      <img src="${imagem}" class="img-produto"
           alt="Foto de ${produto.nome}"
           title="Clique para ampliar"
           onerror="this.src='https://placehold.co/52x52/1a1a24/8888aa?text=?'">
      <div class="produto-info">
        <span class="nome-produto">${produto.nome}</span>
        <span class="quantidade-produto ${estoqueClass}"
              aria-label="Quantidade: ${quantidade}${ariaEstoque}">
          Quantidade: ${estoqueLabel}
        </span>
        ${barcodeTag}
      </div>
      <div class="acoes">
        <button class="btn-acao btn-mais"      title="Adicionar 1"        aria-label="Adicionar 1 unidade de ${produto.nome}">+</button>
        <button class="btn-acao btn-menos"     title="Remover 1"          aria-label="Remover 1 unidade de ${produto.nome}">−</button>
        <button class="btn-acao btn-minus-qtd" title="Ajustar quantidade" aria-label="Ajustar quantidade de ${produto.nome}">−N</button>
        <button class="btn-acao btn-editar"    title="Editar produto"     aria-label="Editar ${produto.nome}">✏️</button>
        <button class="btn-acao btn-remover"   title="Excluir produto"    aria-label="Excluir ${produto.nome}">🗑</button>
      </div>
    `;

    li.querySelector(".img-produto").addEventListener("click", () => abrirModalFoto(imagem));
    li.querySelector(".btn-mais").addEventListener("click", () => aumentar(produto.id, quantidade));
    li.querySelector(".btn-menos").addEventListener("click", () => diminuir(produto.id, quantidade));
    li.querySelector(".btn-minus-qtd").addEventListener("click", () =>
      abrirModalRemoverQtd(produto.id, produto.nome, quantidade)
    );
    li.querySelector(".btn-editar").addEventListener("click", () =>
      abrirModalEditar(produto.id, produto.nome, produto.codigoBarras || "")
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

window.filtrarProdutos = function () {
  const termo = document.getElementById("campoBusca").value.trim().toLowerCase();
  estado.termoBusca = termo;
  if (!termo) { renderizarLista(estado.todosProdutos); return; }
  renderizarLista(estado.todosProdutos.filter(p =>
    p.nome.toLowerCase().includes(termo) ||
    (p.codigoBarras && p.codigoBarras.includes(termo))
  ));
};

window.adicionarProduto = async function () {
  const nome       = document.getElementById("nomeProduto").value.trim();
  const quantidade = parseInt(document.getElementById("quantidadeProduto").value);
  const btn        = document.getElementById("btnAdicionar");
  const spinner    = document.getElementById("btnSpinner");
  const btnText    = document.getElementById("btnText");

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

  btn.disabled = true;
  spinner.classList.add("ativo");
  btnText.textContent = "Adicionando...";

  try {
    await addDoc(collection(window.db, "produtos"), {
      nome,
      quantidade,
      imagem: estado.imagemBase64 || ""
    });

    document.getElementById("nomeProduto").value       = "";
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
function abrirModalEditar(id, nomeAtual, barcodeAtual = "") {
  estado.editarId = id;
  document.getElementById("inputEditarNome").value    = nomeAtual;
  document.getElementById("inputEditarBarcode").value = barcodeAtual;
  pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");
  abrirModal("modalEditar");
  setTimeout(() => document.getElementById("inputEditarNome").focus(), 100);
}

window.fecharModalEditar = function () {
  pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");
  fecharModal("modalEditar");
};

window.salvarEdicao = async function () {
  const novoNome    = document.getElementById("inputEditarNome").value.trim();
  const novoBarcode = document.getElementById("inputEditarBarcode").value.trim();

  if (!novoNome) { showToast("Digite um nome válido", "⚠️"); return; }

  const btn     = document.querySelector("#modalEditar .btn-modal-confirm");
  const spinner = document.getElementById("spinnerEditar");
  const texto   = document.getElementById("textoSalvar");

  btn.disabled = true;
  spinner.classList.add("ativo");
  texto.textContent = "Salvando...";

  pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");

  try {
    await updateDoc(doc(window.db, "produtos", estado.editarId), {
      nome: novoNome,
      codigoBarras: novoBarcode
    });
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
function abrirModalFoto(src) {
  if (!src || src.includes("placehold.co")) return;
  document.getElementById("modalFotoImg").src = src;
  abrirModal("modalFoto");
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
    showToast(`"${nome}" removido`, "🗑️");
    await mostrarProdutos();
  } catch (err) {
    showToast("Erro ao remover", "❌");
    hideLoading();
  }
}

// ── Scanner de câmera (genérico) ─────────────────────────────────
async function iniciarScannerGenerico(scannerState, config) {
  const { areaId, videoId, btnId, onDetect } = config;
  const area  = document.getElementById(areaId);
  const video = document.getElementById(videoId);
  const btn   = document.getElementById(btnId);

  try {
    scannerState.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
    video.srcObject    = scannerState.stream;
    area.style.display = "block";
    btn.classList.add("ativo");
    scannerState.ativo = true;

    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: BARCODE_FORMATS });
      scannerState.interval = setInterval(async () => {
        if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) {
            onDetect(barcodes[0].rawValue);
            pararScannerGenerico(scannerState, areaId, btnId);
          }
        } catch (_) {}
      }, SCANNER_INTERVALO_MS);
    } else {
      const hint = area.querySelector(".scan-hint");
      if (hint) hint.textContent = "Câmera ativa. Digite o código no campo acima caso não seja detectado automaticamente.";
    }
  } catch (err) {
    showToast("Não foi possível acessar a câmera", "❌");
    console.error(err);
  }
}

function pararScannerGenerico(scannerState, areaId, btnId) {
  clearInterval(scannerState.interval);
  scannerState.interval = null;

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
      renderizarLista(estado.todosProdutos.filter(p =>
        p.codigoBarras && p.codigoBarras.includes(codigo)
      ));
      showToast("Código escaneado!", "✅");
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
      showToast("Código capturado!", "✅");
    }
  });
};

// ── Event Listeners ───────────────────────────────────────────────
document.getElementById("btnAdicionar").addEventListener("click", window.adicionarProduto);
document.getElementById("campoBusca").addEventListener("input", window.filtrarProdutos);
document.getElementById("campoBusca").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    window.filtrarProdutos();
    e.target.blur(); // esconde o teclado no celular
  }
});
document.getElementById("btnBuscaCam").addEventListener("click", window.alternarScannerBusca);

document.getElementById("modalFoto").addEventListener("click", () => fecharModal("modalFoto"));
document.querySelector("#modalFoto .modal-foto-box").addEventListener("click", (e) => e.stopPropagation());
document.getElementById("btnFecharFoto").addEventListener("click", () => fecharModal("modalFoto"));

document.getElementById("btnCancelarEditar").addEventListener("click", () => {
  pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");
  fecharModal("modalEditar");
});
document.getElementById("btnSalvarEditar").addEventListener("click", window.salvarEdicao);
document.getElementById("btnScanEditar").addEventListener("click", window.alternarScannerEditar);

document.getElementById("btnCancelarAjuste").addEventListener("click", () => fecharModal("modalRemoverQtd"));
document.getElementById("btnAjusteAdd").addEventListener("click", () => confirmarAjusteQtd("add"));
document.getElementById("btnAjusteRem").addEventListener("click", () => confirmarAjusteQtd("rem"));
document.getElementById("inputRemoverQtd").addEventListener("keydown", (e) => {
  if (e.key === "Enter") confirmarAjusteQtd("add");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    fecharModal("modalFoto");
    pararScannerGenerico(estado.scannerEditar, "scannerAreaEditar", "btnScanEditar");
    fecharModal("modalEditar");
    fecharModal("modalRemoverQtd");
    pararScannerGenerico(estado.scannerBusca, "scannerAreaBusca", "btnBuscaCam");
  }
});