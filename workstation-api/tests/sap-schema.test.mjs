import assert from 'node:assert/strict';
import test from 'node:test';
import { sapColumns, savouryColumns, sapColumnsFor, sapEditableColumns, sapCanFormat } from '../server/dockflow/sap-postgres.js';

const dressings = 'delivery_date encoded_by item description dr_number quantity po_number batch breakdown mfg_date exp_date matdoc supplier_lot remarks supplier_name plate_number driver_name gate_in gate_out destination gatepass_number inventory_controller receiving_controller helper_count truck_type actual_received on_time in_full otif pallet_count warehouse_remarks start_unloading end_unloading qa_start qa_end qa_disposition'.split(' ');
const savoury = 'source_batch source_sheet source_row section_index material_type std classification rol total_weight week date type supplier item_code description uom scheduled_qty scheduled_date time actual_qty dr_number expiration_date batch_no_lot_no plate_no time_received time_start_unloading finished_unloading total_unloading_time time_waiting_to_unload balance status remarks'.split(' ');

test('Receiving Records columns match the supplied source-table schemas', () => {
  assert.deepEqual(sapColumns.map(column => column[3]), dressings);
  assert.deepEqual(savouryColumns.map(column => column[3]), savoury);
  assert.equal(sapColumnsFor('DRESSINGS'), sapColumns);
  assert.equal(sapColumnsFor('SAVOURY'), savouryColumns);
  assert.equal(savouryColumns.some(column => column[3] === 'shipment_id'), false);
  assert.equal(savouryColumns.some(column => column[3] === 'cell_formats'), false);
});

test('Savoury permissions use its own names and allow Ubuntu-managed formatting without new database columns', () => {
  assert.ok(sapEditableColumns('warehouse', 'SAVOURY').includes('actualQty'));
  assert.ok(sapEditableColumns('sap', 'SAVOURY').includes('itemCode'));
  assert.ok(!sapEditableColumns('sap', 'SAVOURY').includes('item'));
  assert.equal(sapCanFormat('admin', 'SAVOURY'), true);
  assert.equal(sapCanFormat('admin', 'DRESSINGS'), true);
});
