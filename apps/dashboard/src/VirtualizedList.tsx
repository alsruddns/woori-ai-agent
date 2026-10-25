import React,{useCallback,useLayoutEffect,useRef,useState}from'react';
import{useVirtualizer}from'@tanstack/react-virtual';

type Props<T>={items:T[];getItemKey:(item:T,index:number)=>string;renderItem:(item:T,index:number)=>React.ReactNode;ariaLabel:string;height?:number;estimateSize?:number;overscan?:number;virtualizeFrom?:number;followNewItems?:boolean;newestAtStart?:boolean};

/** Variable-height virtual list. Keeps the reader's position when live items arrive. */
export function VirtualizedList<T>({items,getItemKey,renderItem,ariaLabel,height=560,estimateSize=104,overscan=8,virtualizeFrom=40,followNewItems=true,newestAtStart=false}:Props<T>){
 const scrollRef=useRef<HTMLDivElement>(null),wasAtEnd=useRef(true),previousCount=useRef(items.length),anchor=useRef<{key:string;index:number;offset:number}|null>(null),[follow,setFollow]=useState(followNewItems),[newItems,setNewItems]=useState(0);
 const virtualizer=useVirtualizer({count:items.length,getScrollElement:()=>scrollRef.current,estimateSize:()=>estimateSize,overscan,getItemKey:index=>getItemKey(items[index],index)});
 const atFollowPosition=useCallback(()=>{const el=scrollRef.current;if(!el)return true;return newestAtStart?el.scrollTop<28:el.scrollHeight-el.scrollTop-el.clientHeight<28},[newestAtStart]);
 const onScroll=useCallback(()=>{const el=scrollRef.current;wasAtEnd.current=atFollowPosition();if(el){const top=el.getBoundingClientRect().top;const first=virtualizer.getVirtualItems().find(item=>item.end>el.scrollTop);if(first){const node=el.querySelector<HTMLElement>(`[data-index="${first.index}"]`);anchor.current={key:getItemKey(items[first.index],first.index),index:first.index,offset:node?node.getBoundingClientRect().top-top:first.start-el.scrollTop}}}if(wasAtEnd.current){setNewItems(0);if(!follow)setFollow(true)}else if(follow)setFollow(false)},[atFollowPosition,follow,getItemKey,items,virtualizer]);
 useLayoutEffect(()=>{const added=Math.max(0,items.length-previousCount.current);previousCount.current=items.length;if(!added)return;if(wasAtEnd.current&&follow){virtualizer.scrollToIndex(newestAtStart?0:items.length-1,{align:newestAtStart?'start':'end'});setNewItems(0);return}setNewItems(value=>value+added);const saved=anchor.current;if(!saved)return;const index=items.findIndex((item,i)=>getItemKey(item,i)===saved.key);if(index<0||index===saved.index)return;virtualizer.scrollToIndex(index,{align:'start'});const virtualItem=virtualizer.getVirtualItems().find(item=>item.index===index);const el=scrollRef.current;if(virtualItem&&el)el.scrollTop=virtualItem.start-saved.offset},[items,follow,getItemKey,newestAtStart,virtualizer]);
 const scrollToLatest=()=>{if(items.length)virtualizer.scrollToIndex(newestAtStart?0:items.length-1,{align:newestAtStart?'start':'end'});setFollow(true);setNewItems(0)};
 const virtual=items.length>=virtualizeFrom;
 return <div className="virtual-list-shell">
  <div className="virtual-list-controls"><label><input type="checkbox" checked={follow} onChange={event=>{setFollow(event.target.checked);if(event.target.checked)scrollToLatest()}}/> 새 이벤트 따라가기</label>{newItems>0&&<button type="button" className="link-button" onClick={scrollToLatest}>새 이벤트 {newItems}개 · 최신으로 이동</button>}</div>
  <div ref={scrollRef} className="virtual-list-scroll" style={{height}} role="log" aria-label={ariaLabel} aria-live="off" tabIndex={0} onScroll={onScroll}>
   {virtual?<div className="virtual-list-inner" style={{height:virtualizer.getTotalSize()}}>{virtualizer.getVirtualItems().map(item=><div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="virtual-list-item" style={{transform:`translateY(${item.start}px)`}}>{renderItem(items[item.index],item.index)}</div>)}</div>:<div className="virtual-list-inner virtual-list-static">{items.map((item,index)=><div key={getItemKey(item,index)} className="virtual-list-item">{renderItem(item,index)}</div>)}</div>}
   {!items.length&&<div className="virtual-state">이벤트가 없습니다.</div>}
  </div>
 </div>
}
