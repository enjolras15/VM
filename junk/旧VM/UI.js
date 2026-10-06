var tabs=[];
var id=0;
currentId=0;

class tabClass {
 constructor(id) {
    this.id=id;
    this.text="";
 }

 save(text) {
    this.text=text;
 }

}

const tabs_dom = document.querySelector('.tabs');
const addBtn = document.querySelector('.add');

addBtn.addEventListener('click', () => {

  createTab();
  
});

function changeTab(id) {
    tabs[currentId].save(document.getElementById("source").value)
    currentId=id;
    document.getElementById("source").value=tabs[id].text;

  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active');
  });

  const activeTab = document.querySelector(`.tab[data-id="${id}"]`);
  if (activeTab) {
    activeTab.classList.add('active');
  }


}

function createTab() {

  const tab = document.createElement('div');
  tab.className = 'tab';

  tab.innerHTML =`<span class="title">${id}</span>`;

  if(id!=0) {
      tab.innerHTML +=`<button class="close">×</button>`;
  }

  tabs[id] = new tabClass(id);
  tab.dataset.id = id;
  tabs_dom.insertBefore(tab, addBtn);
  changeTab(id);
  id++

}

tabs_dom.addEventListener('click', (e) => {

  // ×ボタン
  if (e.target.classList.contains('close')) {
    e.target.closest('.tab').remove();
    return;
  }

  // タブ本体
  const tabEl = e.target.closest('.tab');
  if (!tabEl) return;

  const tabId = tabEl.dataset.id;
  console.log(tabId);
  changeTab(Number(tabId));
});

createTab();

