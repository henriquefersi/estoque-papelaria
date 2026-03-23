import {
collection,
addDoc,
getDocs,
doc,
updateDoc,
deleteDoc
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

const lista = document.getElementById("listaProdutos");

async function mostrarProdutos(){

lista.innerHTML = "";

const querySnapshot = await getDocs(collection(window.db,"produtos"));

let totalProdutos = 0;
let totalItens = 0;

querySnapshot.forEach((documento)=>{

const produto = documento.data();
const id = documento.id;

const quantidade = Number(produto.quantidade) || 0;
const imagem = produto.imagem || "https://via.placeholder.com/50";

lista.innerHTML += `
<li class="produto-item">

<img src="${imagem}" class="img-produto">

<div class="produto-info">
<span class="nome-produto">${produto.nome}</span>
<span class="quantidade-produto">Quantidade: ${quantidade}</span>
</div>

<div class="acoes">
<button class="btn-mais" onclick="aumentar('${id}', ${quantidade})">+</button>
<button class="btn-menos" onclick="diminuir('${id}', ${quantidade})">-</button>
<button class="btn-remover" onclick="remover('${id}')">🗑</button>
</div>

</li>
`;

totalProdutos++;
totalItens += quantidade;

});

document.getElementById("totalProdutos").innerText =
"Total de produtos: " + totalProdutos;

document.getElementById("totalItens").innerText =
"Total de itens no estoque: " + totalItens;

}

window.mostrarProdutos = mostrarProdutos;


window.adicionarProduto = async function(){

let nome = document.getElementById("nomeProduto").value;

let quantidade = parseInt(
document.getElementById("quantidadeProduto").value
);

let imagem = document.getElementById("imagemProduto").value;

if(!nome || !quantidade){
alert("Preencha os campos");
return;
}

await addDoc(collection(window.db,"produtos"),{
nome:nome,
quantidade:quantidade,
imagem:imagem
});

document.getElementById("nomeProduto").value = "";
document.getElementById("quantidadeProduto").value = "";
document.getElementById("imagemProduto").value = "";

mostrarProdutos();

}


window.aumentar = async function(id, quantidade){

const ref = doc(window.db,"produtos",id);

await updateDoc(ref,{
quantidade: quantidade + 1
});

mostrarProdutos();

}


window.diminuir = async function(id, quantidade){

if(quantidade <= 0) return;

const ref = doc(window.db,"produtos",id);

await updateDoc(ref,{
quantidade: quantidade - 1
});

mostrarProdutos();

}


window.remover = async function(id){

const ref = doc(window.db,"produtos",id);

await deleteDoc(ref);

mostrarProdutos();

}

mostrarProdutos();