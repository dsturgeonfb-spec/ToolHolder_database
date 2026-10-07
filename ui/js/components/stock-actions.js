// STUB — owned by the stock module. Contract:
//   openStockAction(kind, holder, opts?) -> Promise<boolean>   (true if a transaction was posted)
//     kind: 'receipt' | 'move' | 'scrap' | 'return' | 'adjust'
//     holder: { holder_id, manufacturer, order_no, ... } (any holder object from the API)
//     opts: { locationId?: number }  preselects a location
export async function openStockAction(kind, holder, opts = {}) {
  return false
}
