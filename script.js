import {
  collection,
  addDoc,
  getDocs,
  doc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const lista = document.getElementById("listaProdutos");
const overlay = document.getElementById("loadingOverlay");
const toast = document.getElementById("toast");

/* ── Helpers de UI ── */

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

/* ── Upload de imagem ── */

let imagemBase64 = "";

const uploadArea  = document.getElementById("uploadArea");
const fileInput   = document.getElementById("fileInput");
const preview     = document.getElementById("uploadPreview");

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      // Reduz para no máximo 400px de largura mantendo proporção
      const MAX = 400;
      const scale = Math.min(1, MAX / img.width);
      const canvas = document.createElement("canvas");
      canvas.width  = img.width  * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      // Comprime para JPEG com qualidade 70%
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

/* ── Listar produtos ── */

async function mostrarProdutos() {
  showLoading("Buscando produtos...");
  lista.innerHTML = "";

  try {
    const querySnapshot = await getDocs(collection(window.db, "produtos"));

    let totalProdutos = 0;
    let totalItens = 0;

    if (querySnapshot.empty) {
      lista.innerHTML = `
        <div class="lista-vazia">
          <div class="lista-vazia-icon">📦</div>
          <p>Nenhum produto cadastrado ainda.</p>
        </div>`;
    }

    querySnapshot.forEach((documento) => {
      const produto = documento.data();
      const id = documento.id;
      const quantidade = Number(produto.quantidade) || 0;
      const imagem = produto.imagem || "https://placehold.co/52x52/1a1a24/8888aa?text=?";
      const estoqueClass = quantidade <= 2 ? "estoque-baixo" : "";
      const estoqueLabel = quantidade <= 2 ? `⚠️ ${quantidade}` : quantidade;

      const li = document.createElement("li");
      li.className = "produto-item";
      li.innerHTML = `
        <img src="${imagem}" class="img-produto" onerror="this.src='https://placehold.co/52x52/1a1a24/8888aa?text=?'">
        <div class="produto-info">
          <span class="nome-produto">${produto.nome}</span>
          <span class="quantidade-produto ${estoqueClass}">Quantidade: ${estoqueLabel}</span>
        </div>
        <div class="acoes">
          <button class="btn-acao btn-mais"  title="Aumentar">+</button>
          <button class="btn-acao btn-menos" title="Diminuir">−</button>
          <button class="btn-acao btn-remover" title="Remover">🗑</button>
        </div>
      `;

      li.querySelector(".btn-mais").addEventListener("click", () => aumentar(id, quantidade));
      li.querySelector(".btn-menos").addEventListener("click", () => diminuir(id, quantidade));
      li.querySelector(".btn-remover").addEventListener("click", () => confirmarRemover(id, produto.nome));

      lista.appendChild(li);

      totalProdutos++;
      totalItens += quantidade;
    });

    document.getElementById("totalProdutos").textContent = totalProdutos;
    document.getElementById("totalItens").textContent = totalItens;

  } catch (err) {
    showToast("Erro ao carregar produtos", "❌");
    console.error(err);
  } finally {
    hideLoading();
  }
}

window.mostrarProdutos = mostrarProdutos;

/* ── Adicionar produto ── */

window.adicionarProduto = async function () {
  const nome = document.getElementById("nomeProduto").value.trim();
  const quantidade = parseInt(document.getElementById("quantidadeProduto").value);
  const btn = document.getElementById("btnAdicionar");
  const spinner = document.getElementById("btnSpinner");
  const btnText = document.getElementById("btnText");

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

    document.getElementById("nomeProduto").value = "";
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

/* ── Aumentar ── */

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

/* ── Diminuir ── */

async function diminuir(id, quantidade) {
  if (quantidade <= 0) {
    showToast("Quantidade já está em zero", "⚠️");
    return;
  }
  showLoading("Atualizando...");
  try {
    await updateDoc(doc(window.db, "produtos", id), { quantidade: quantidade - 1 });
    await mostrarProdutos();
  } catch (err) {
    showToast("Erro ao atualizar", "❌");
    hideLoading();
  }
}

/* ── Remover com confirmação ── */

function confirmarRemover(id, nome) {
  const confirmado = confirm(`Remover "${nome}" do estoque?`);
  if (confirmado) remover(id, nome);
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

/* ── Init ── */
mostrarProdutos();