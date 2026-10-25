import React,{useRef}from'react';
import{useVirtualizer}from'@tanstack/react-virtual';

export type VirtualTableColumn<T>={key:string;label:string;width?:string;render:(row:T,index:number)=>React.ReactNode};
type Props<T>={rows:T[];columns:VirtualTableColumn<T>[];getRowKey:(row:T,index:number)=>string;ariaLabel:string;height?:number;rowHeight?:number;overscan?:number;virtualizeFrom?:number;selectedRowKey?:string|null;onRowClick?:(row:T)=>void;emptyState?:React.ReactNode;loading?:boolean;error?:string};

/** A compact, sticky-header table that keeps large result sets out of the DOM. */
export function VirtualizedTable<T>({rows,columns,getRowKey,ariaLabel,height=520,rowHeight=52,overscan=8,virtualizeFrom=40,selectedRowKey,onRowClick,emptyState='표시할 데이터가 없습니다.',loading=false,error}:Props<T>){
 const scrollRef=useRef<HTMLDivElement>(null);
 const virtualizer=useVirtualizer({count:rows.length,getScrollElement:()=>scrollRef.current,estimateSize:()=>rowHeight,overscan,getItemKey:index=>getRowKey(rows[index],index)});
 const shouldVirtualize=rows.length>=virtualizeFrom;
 const grid=columns.map(column=>column.width??'minmax(140px, 1fr)').join(' ');
 const renderRow=(row:T,index:number,virtualStyle?:React.CSSProperties)=>{const rowKey=getRowKey(row);return <tr key={rowKey} data-index={shouldVirtualize?index:undefined} ref={shouldVirtualize?virtualizer.measureElement:undefined} aria-selected={selectedRowKey===rowKey||undefined} className={onRowClick?'virtual-row-clickable':''} onClick={onRowClick?()=>onRowClick(row):undefined} onKeyDown={onRowClick?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onRowClick(row)}}:undefined} tabIndex={onRowClick?0:undefined} style={{gridTemplateColumns:grid,...virtualStyle}}>{columns.map(column=><td key={column.key} title={typeof row[column.key]==='string'?row[column.key]:undefined}>{column.render(row,index)}</td>)}</tr>};
 return <div ref={scrollRef} className="virtual-table-scroll" style={{maxHeight:height}} role="region" aria-label={ariaLabel} tabIndex={0}>
  {error&&<div className="error" role="alert">{error}</div>}
  {loading&&<p className="virtual-state" role="status">불러오는 중…</p>}
  {!loading&&!rows.length?<div className="virtual-state">{emptyState}</div>:<table className={shouldVirtualize?'virtual-table virtual-table-virtual':'virtual-table'} aria-label={ariaLabel}>
   <thead><tr style={{gridTemplateColumns:grid}}>{columns.map(column=><th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
   <tbody style={shouldVirtualize?{height:virtualizer.getTotalSize()}:undefined}>
    {shouldVirtualize?virtualizer.getVirtualItems().map(item=>renderRow(rows[item.index],item.index,{transform:`translateY(${item.start}px)`})):rows.map((row,index)=>renderRow(row,index))}
   </tbody>
  </table>}
 </div>
}
